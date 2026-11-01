import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';

export const db=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL}):new PGlite(process.env.DATA_DIR||'.data');
export async function init(){
const schema=`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,access_hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT NOT NULL,topic TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER REFERENCES users(id),post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,post_id));
CREATE TABLE IF NOT EXISTS bookmarks(user_id INTEGER REFERENCES users(id),post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,post_id));
CREATE TABLE IF NOT EXISTS comments(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id),post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,body TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());`;
for(const statement of schema.split(';').filter(s=>s.trim()))await db.query(statement);
await db.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS characters JSONB NOT NULL DEFAULT '[]'");
await db.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS events JSONB NOT NULL DEFAULT '[]'");
// Existing identities are removed; old sessions must not bypass verification.
await db.query(`DO $$ BEGIN CREATE TYPE user_role AS ENUM ('default', 'premium'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'default'");
await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS user_verified BOOLEAN NOT NULL DEFAULT FALSE');
await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS access_hash TEXT UNIQUE');
await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ');
await db.query('CREATE TABLE IF NOT EXISTS subscriptions(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,plan TEXT NOT NULL,starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())');
for(const column of ['name','handle','password','color']) await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${column}`);
await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE user_verified=FALSE)');
if(!(await db.query('SELECT id FROM users LIMIT 1')).rows.length){
for(let i=0;i<4;i++)await db.query('INSERT INTO users DEFAULT VALUES');
for(const [uid,body,topic] of [[1,'Кажется, главный взрослый навык — отменять планы без чувства вины.\n\nИли мы просто коллективно устали?','Жизнь'],[2,'Непопулярное мнение: маленькая кофейня у дома важнее ещё одного торгового центра.\n\nУ вас есть место, где уже знают «вам как обычно»?','Город'],[3,'Почему все обсуждают финал сериала, но никто — тот факт, что лучший персонаж появился всего на 12 минут? 👀','Культура'],[4,'В нашей компании ввели пятницу без созвонов. За один день сделали то, что обсуждали две недели. Совпадение?','Работа'],[1,'Этот пост — знак написать другу, с которым вы всё время собираетесь встретиться. Кофе сам себя не выпьет ☕','Жизнь']]) await db.query('INSERT INTO posts(user_id,body,topic) VALUES($1,$2,$3)',[uid,body,topic]);
await db.query("INSERT INTO comments(user_id,post_id,body) VALUES(2,1,'Мне кажется, это умение выбирать себя. И немного усталость :)')");
await db.query('INSERT INTO likes(user_id,post_id) VALUES(2,1),(3,1),(4,2),(1,3)');
}}
