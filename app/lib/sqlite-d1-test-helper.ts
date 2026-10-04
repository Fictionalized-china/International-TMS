import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** SQLite-backed D1 test adapter: batch failures really roll back all writes. */
export function sqliteD1(database:DatabaseSync):D1Database {
  class Statement {
    values:SQLInputValue[] = [];
    constructor(readonly sql:string) {}
    bind(...values:SQLInputValue[]) {this.values=values;return this;}
    async first() {return database.prepare(this.sql).get(...this.values) || null;}
    async all() {return {results:database.prepare(this.sql).all(...this.values),success:true,meta:{}};}
    async run() {
      const result = database.prepare(this.sql).run(...this.values);
      return {results:[],success:true,meta:{changes:Number(result.changes)}};
    }
  }
  return {
    prepare:(sql:string) => new Statement(sql),
    async batch(statements:Statement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results=[];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");return results;
      } catch(error) {database.exec("ROLLBACK");throw error;}
    },
  } as unknown as D1Database;
}
