// 锁机制实测用夹具：持有一个 SQLite 独占锁直到被杀，用于观察第二个连接的可见行为。
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
const db = new DatabaseSync(path);
db.exec("PRAGMA locking_mode = EXCLUSIVE");
db.exec("create table if not exists held(x text)");
db.exec("insert into held values ('占住文件锁')");
db.exec("begin");
db.prepare("select count(*) as n from held").get();
console.log(`READY ${process.pid}`);
setTimeout(() => {}, 10 * 60 * 1000);
