declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
        role: "super_admin" | "admin" | "operator" | "viewer";
        permissions: Record<string, boolean>;
        isRoot: boolean;
      };
    }
  }
}

export {};
