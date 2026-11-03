import express from 'express';
import {db} from './db.js';
import {isPremium} from './premium.js';
export const notificationRouter=express.Router();
const run=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
// Never tells who acted: a notification only names its type, target and how many times it happened.
// Premium-only content is announced only to premium accounts.
export async function notify(userId,type,{post=null,comment=null,community=null,silent=false,premiumOnly=false}={}){
if(!userId)return;
await db.query(`INSERT INTO notifications(user_id,type,post_id,comment_id,community_id,silent) SELECT $1::int,$2::text,$3::int,$4::int,$5::int,$6::boolean WHERE NOT $7::boolean OR ${isPremium('$1::int')} ON CONFLICT (user_id,type,COALESCE(post_id,0),COALESCE(comment_id,0),COALESCE(community_id,0)) WHERE NOT read DO UPDATE SET count=notifications.count+1,created_at=NOW()`,[userId,type,post,comment,community,silent,premiumOnly]);
}
// Muted members still get the notification, but silently: it is listed without raising the unread badge.
export async function notifyCommunity(communityId,postId,authorId,premiumOnly=false){await db.query(`INSERT INTO notifications(user_id,type,post_id,community_id,silent) SELECT user_id,'community_post',$2,$1,muted FROM community_members m WHERE community_id=$1 AND user_id<>$3 AND (NOT $4::boolean OR ${isPremium('m.user_id')}) ON CONFLICT DO NOTHING`,[communityId,postId,authorId,premiumOnly])}
// Read notifications live 30 days, unread ones 90.
export async function cleanupNotifications(){await db.query("DELETE FROM notifications WHERE created_at<NOW()-CASE WHEN read THEN INTERVAL '30 days' ELSE INTERVAL '90 days' END")}
export async function startNotificationCleanup(ms=3600000){await cleanupNotifications();const timer=setInterval(()=>cleanupNotifications().catch(()=>{}),ms);timer.unref()}
notificationRouter.get('/',run(async(req,res)=>res.json((await db.query(`SELECT n.id,n.type,n.count,n.silent,n.read,n.created_at,n.post_id,n.comment_id,n.community_id,c.name AS community,LEFT(p.body,140) AS post_excerpt,LEFT(cm.body,140) AS comment_excerpt FROM notifications n LEFT JOIN posts p ON p.id=n.post_id LEFT JOIN comments cm ON cm.id=n.comment_id LEFT JOIN communities c ON c.id=n.community_id WHERE n.user_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 50`,[req.user.id])).rows)));
notificationRouter.get('/unread',run(async(req,res)=>res.json((await db.query('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 AND NOT read AND NOT silent',[req.user.id])).rows[0])));
notificationRouter.post('/read',run(async(req,res)=>{await db.query('UPDATE notifications SET read=TRUE WHERE user_id=$1 AND NOT read',[req.user.id]);res.json({ok:true})}));
