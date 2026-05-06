import type { Request, Response } from "express";
export declare function listFoldersHandler(_req: Request, res: Response): Promise<void>;
export declare function createFolderHandler(req: Request, res: Response): Promise<void>;
export declare function updateFolderHandler(req: Request, res: Response): Promise<void>;
export declare function deleteFolderHandler(req: Request, res: Response): Promise<void>;
