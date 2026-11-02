// "For you" ranking for viewer $1, computed per request in SQL: no interest profile is stored.
// Signals: likes (1), comments (1.5) and saves (2). Ranking factors:
// favourite topics, words from liked and saved stories (Russian stemming), posts liked by people
// with the same likes, the viewer's communities, popularity and freshness (5-day decay); dislikes push a post down.
export const recommendCtes=`signals AS (SELECT post_id,1.0 AS w FROM likes WHERE user_id=$1 UNION ALL SELECT post_id,2.0 FROM bookmarks WHERE user_id=$1 UNION ALL SELECT DISTINCT post_id,1.5 FROM comments WHERE user_id=$1),
topics AS (SELECT p.topic,SUM(s.w)/(SELECT SUM(w) FROM signals) AS share FROM signals s JOIN posts p ON p.id=s.post_id GROUP BY p.topic),
terms AS (SELECT string_agg(quote_literal(word),' | ')::tsquery AS q FROM (SELECT word FROM ts_stat('SELECT search FROM posts WHERE id IN (SELECT post_id FROM likes WHERE user_id='||$1::int||' UNION SELECT post_id FROM bookmarks WHERE user_id='||$1::int||')') WHERE length(word)>2 ORDER BY ndoc DESC,nentry DESC,word LIMIT 20) top),
peers AS (SELECT l2.post_id,COUNT(*) AS n FROM likes l1 JOIN likes l2 ON l2.user_id=l1.user_id WHERE l1.post_id IN (SELECT post_id FROM likes WHERE user_id=$1) AND l1.user_id<>$1 GROUP BY l2.post_id)`;
export const recommendScore=`(2*COALESCE((SELECT share FROM topics WHERE topic=p.topic),0)
+15*COALESCE(ts_rank(p.search,(SELECT q FROM terms)),0)
+1.5*LN(1+COALESCE((SELECT n FROM peers WHERE post_id=p.id),0))
+CASE WHEN p.community_id IN (SELECT community_id FROM community_members WHERE user_id=$1) THEN 1 ELSE 0 END
+0.5*LN(1+(SELECT COUNT(*) FROM likes WHERE post_id=p.id))
+1.5*EXP(-EXTRACT(EPOCH FROM NOW()-p.created_at)/432000)
-2*LN(1+(SELECT COUNT(*) FROM post_dislikes WHERE post_id=p.id)))`;
