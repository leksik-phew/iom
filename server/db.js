import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import bcrypt from 'bcryptjs';
export const db=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL}):new PGlite(process.env.DATA_DIR||'.data');
export async function init(){
const schema=`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,handle TEXT UNIQUE NOT NULL,password TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#e5dff8');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id),body TEXT NOT NULL,topic TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER REFERENCES users(id),post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,post_id));
CREATE TABLE IF NOT EXISTS bookmarks(user_id INTEGER REFERENCES users(id),post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,PRIMARY KEY(user_id,post_id));
CREATE TABLE IF NOT EXISTS comments(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES users(id),post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,body TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());`;
for(const statement of schema.split(';').filter(s=>s.trim()))await db.query(statement);
if(!(await db.query('SELECT id FROM users LIMIT 1')).rows.length){
const password=await bcrypt.hash('iom-demo-2026',10);
for(const [name,handle,color] of [['Аня','anya','#e2daf5'],['Марк','mark','#d9e8db'],['Лера','lera','#f7dccb'],['Саша','sasha','#dce5f4']]) await db.query('INSERT INTO users(name,handle,password,color) VALUES($1,$2,$3,$4)',[name,handle,password,color]);
for(const [uid,body,topic] of [[1,'Кажется, главный взрослый навык — отменять планы без чувства вины.\n\nИли мы просто коллективно устали?','Жизнь'],[2,'Непопулярное мнение: маленькая кофейня у дома важнее ещё одного торгового центра.\n\nУ вас есть место, где уже знают «вам как обычно»?','Город'],[3,'Почему все обсуждают финал сериала, но никто — тот факт, что лучший персонаж появился всего на 12 минут? 👀','Культура'],[4,'В нашей компании ввели пятницу без созвонов. За один день сделали то, что обсуждали две недели. Совпадение?','Работа'],[1,'Этот пост — знак написать другу, с которым вы всё время собираетесь встретиться. Кофе сам себя не выпьет ☕','Жизнь']]) await db.query('INSERT INTO posts(user_id,body,topic) VALUES($1,$2,$3)',[uid,body,topic]);
await db.query("INSERT INTO comments(user_id,post_id,body) VALUES(2,1,'Мне кажется, это умение выбирать себя. И немного усталость :)')");
await db.query('INSERT INTO likes(user_id,post_id) VALUES(2,1),(3,1),(4,2),(1,3)');
}}
