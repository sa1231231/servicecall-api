declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
        role: "admin" | "operator";
      };
    }
  }
}

export {};
