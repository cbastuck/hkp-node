/**
 * One process of a multi-process test. Run by `database-processes.test.ts`.
 *
 * Not a test itself: it is the other side of one, because what is being
 * checked — two runtime servers writing one file — cannot be observed from
 * inside a single process.
 *
 * argv: <root> <owner> <database> <tag> <writes>
 */
import { createFileDatabaseStore } from "../src/services/database";

const [root, owner, name, tag, writes] = process.argv.slice(2);

const store = createFileDatabaseStore(root);
const db = store.openNamed(owner, name);

db.exec(
  "CREATE TABLE IF NOT EXISTS message (id INTEGER PRIMARY KEY, who TEXT NOT NULL, n INTEGER NOT NULL)",
);

let written = 0;
let failed = 0;
for (let n = 0; n < Number(writes); n += 1) {
  try {
    db.run("INSERT INTO message (who, n) VALUES ($who, $n)", { $who: tag, $n: n });
    written += 1;
  } catch {
    failed += 1;
  }
}

store.closeAll();
process.stdout.write(JSON.stringify({ tag, written, failed }));
