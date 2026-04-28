declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
        role: "admin" | "operator" | "viewer";
        permissions: Record<string, boolean>;
        isOwner: boolean;
      };
    }
  }
}

export {};
