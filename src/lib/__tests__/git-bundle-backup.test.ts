import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockS3Send, mockExecFile, mockReadFile, mockMkdtemp, mockRm, mockConfig,
} = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockExecFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockRm: vi.fn(),
  mockConfig: {
    R2_ENDPOINT: "https://r2.example",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "test-bucket",
    GITHUB_TOKEN: "ghp_fake_token",
  } as Record<string, string>,
}));

vi.mock("../../config.js", () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mockS3Send; },
  PutObjectCommand: class { input: any; constructor(input: any) { this.input = input; } static commandName = "PutObjectCommand"; },
  ListObjectsV2Command: class { input: any; constructor(input: any) { this.input = input; } static commandName = "ListObjectsV2Command"; },
  DeleteObjectsCommand: class { input: any; constructor(input: any) { this.input = input; } static commandName = "DeleteObjectsCommand"; },
}));

// promisify(execFile) returns the mock directly when execFile.__promisify__
// isn't set, but the simplest path is to mock the whole child_process module
// so `execFile` resolves a promise (we use the promisified form).
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => {
    // Last arg is the node-style callback when called by util.promisify.
    const cb = args[args.length - 1];
    Promise.resolve(mockExecFile(...args.slice(0, -1))).then(
      (val) => cb(null, val),
      (err) => cb(err),
    );
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...a: any[]) => mockReadFile(...a),
  mkdtemp: (...a: any[]) => mockMkdtemp(...a),
  rm: (...a: any[]) => mockRm(...a),
}));

const {
  runGitBundleBackup,
  isGitBundleBackupConfigured,
} = await import("../git-bundle-backup.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.R2_ENDPOINT = "https://r2.example";
  mockConfig.R2_ACCESS_KEY_ID = "key";
  mockConfig.R2_SECRET_ACCESS_KEY = "secret";
  mockConfig.R2_BUCKET = "test-bucket";
  mockConfig.GITHUB_TOKEN = "ghp_fake_token";
  mockS3Send.mockResolvedValue({});
  mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
  mockMkdtemp.mockResolvedValue("/tmp/repo-backup-abc");
  mockReadFile.mockResolvedValue(Buffer.from("FAKE BUNDLE BYTES"));
  mockRm.mockResolvedValue(undefined);
});

describe("isGitBundleBackupConfigured", () => {
  it("returns true when all required env vars are set", () => {
    expect(isGitBundleBackupConfigured()).toBe(true);
  });

  it("returns false when GITHUB_TOKEN is empty", () => {
    mockConfig.GITHUB_TOKEN = "";
    expect(isGitBundleBackupConfigured()).toBe(false);
  });

  it("returns false when R2 endpoint is empty", () => {
    mockConfig.R2_ENDPOINT = "";
    expect(isGitBundleBackupConfigured()).toBe(false);
  });
});

describe("runGitBundleBackup", () => {
  it("returns success: false when not configured", async () => {
    mockConfig.GITHUB_TOKEN = "";

    const result = await runGitBundleBackup();

    expect(result.success).toBe(false);
    expect(result.error).toBe("not configured");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("clones, bundles, and uploads to R2 under repo-backups/YYYY-MM-DD.bundle", async () => {
    const result = await runGitBundleBackup();

    expect(result.success).toBe(true);
    expect(result.key).toMatch(/^repo-backups\/\d{4}-\d{2}-\d{2}\.bundle$/);

    // Two git invocations: clone --mirror, then bundle create --all.
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const cloneCall = mockExecFile.mock.calls[0];
    expect(cloneCall[0]).toBe("git");
    expect(cloneCall[1]).toEqual([
      "clone",
      "--mirror",
      "https://x-access-token:ghp_fake_token@github.com/sa1231231/servicecall-api.git",
      "/tmp/repo-backup-abc/repo.git",
    ]);
    const bundleCall = mockExecFile.mock.calls[1];
    expect(bundleCall[0]).toBe("git");
    expect(bundleCall[1]).toEqual([
      "-C",
      "/tmp/repo-backup-abc/repo.git",
      "bundle",
      "create",
      "/tmp/repo-backup-abc/repo.bundle",
      "--all",
    ]);

    const putCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "PutObjectCommand");
    expect(putCall).toBeDefined();
    expect(putCall![0].input).toMatchObject({
      Bucket: "test-bucket",
      ContentType: "application/octet-stream",
    });
    expect(putCall![0].input.Body).toBeInstanceOf(Buffer);
    expect(putCall![0].input.Key).toBe(result.key);
  });

  it("removes the temp dir even when the clone fails", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("fatal: repo not found"));

    const result = await runGitBundleBackup();

    expect(result.success).toBe(false);
    expect(mockRm).toHaveBeenCalledWith(
      "/tmp/repo-backup-abc",
      { recursive: true, force: true },
    );
  });

  it("scrubs the token from error messages", async () => {
    mockExecFile.mockRejectedValueOnce(new Error(
      "Failed to clone https://x-access-token:ghp_fake_token@github.com/sa1231231/servicecall-api.git",
    ));

    const result = await runGitBundleBackup();

    expect(result.success).toBe(false);
    expect(result.error).not.toContain("ghp_fake_token");
    expect(result.error).toContain("x-access-token:***@");
  });

  it("deletes bundles older than 90 days", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 120);
    const recentDate = new Date();

    mockS3Send.mockImplementation((cmd: any) => {
      if (cmd.constructor.commandName === "ListObjectsV2Command") {
        return Promise.resolve({
          Contents: [
            { Key: "repo-backups/old.bundle", LastModified: oldDate },
            { Key: "repo-backups/recent.bundle", LastModified: recentDate },
          ],
        });
      }
      return Promise.resolve({});
    });

    await runGitBundleBackup();

    const deleteCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "DeleteObjectsCommand");
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0].input.Delete.Objects).toEqual([{ Key: "repo-backups/old.bundle" }]);
  });

  it("does not call DeleteObjectsCommand when no old bundles exist", async () => {
    mockS3Send.mockImplementation((cmd: any) => {
      if (cmd.constructor.commandName === "ListObjectsV2Command") {
        return Promise.resolve({ Contents: [] });
      }
      return Promise.resolve({});
    });

    await runGitBundleBackup();

    const deleteCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "DeleteObjectsCommand");
    expect(deleteCall).toBeUndefined();
  });

  it("cleanup errors do not affect overall success", async () => {
    mockS3Send.mockImplementation((cmd: any) => {
      if (cmd.constructor.commandName === "ListObjectsV2Command") {
        return Promise.reject(new Error("list-fail"));
      }
      return Promise.resolve({});
    });

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runGitBundleBackup();

    expect(result.success).toBe(true);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("cleanup failed"),
      "list-fail",
    );
    err.mockRestore();
  });
});
