import { type Db } from "mongodb";
export declare function initDb(): Promise<Db>;
export declare function getDb(): Db;
