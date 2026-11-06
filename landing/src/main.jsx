import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VenetianMask,MailX,KeyRound,MessageCircleOff,UsersRound,EyeOff,ArrowDown,Sun,Moon} from 'lucide-react';
import '@fontsource/pixelify-sans/400.css';import '@fontsource/pixelify-sans/700.css';import '@fontsource/tiny5/400.css';import '@fontsource/rubik/400.css';import '@fontsource/rubik/500.css';
import './style.css';

// Where the platform lives; set VITE_APP_URL for the Pages build.
const APP_URL=(import.meta.env.VITE_APP_URL||'https://45.9.117.101:3443').replace(/\/$/,'');
const calm=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

const whispers=['ты слышал?','только никому','Персонаж А опять…','между нами','а она в курсе?','я тебе ничего не говорил','это точно он','все уже знают','не пересказывай','скрин есть','по секрету','угадай кто','Коллега Б…','а я так и знал','№1337','не я это написал','удали потом','кто-то из наших'];
const features=[[VenetianMask,'Все — «Пользователь»','Ни ников, ни аватарок. Автор любой сплетни подписан одинаково.'],[MailX,'Почта сгорает','Нужна один раз для кода подтверждения и сразу удаляется.'],[KeyRound,'Вход по ключу','Секретный ключ выдаётся один раз. Потерял — аккаунта больше нет.'],[MessageCircleOff,'Чаты без следов','Личные переписки нигде не сохраняются и исчезают через сутки.'],[UsersRound,'Свои круги','Сообщества по интересам: офис, район, общага, бывшие.'],[EyeOff,'Без реальных имён','Только «Персонаж А» и «Коллега». Узнать можно — доказать нельзя.']];
// Example posts; the hidden words show on hover or tap.
const posts=[['Работа','Персонаж А третий раз за месяц уходит «к стоматологу» ровно в пятницу в 15:00. Зубы у него, видимо, ',['золотые'],'.'],['Город','Бариста в кофейне у дома пишет на стаканах не имена, а оценки. Мне поставили ',['четыре'],' из десяти.'],['Отношения','Сосед сверху каждый вечер в 23:00 двигает мебель. Подозреваю, что это не мебель, а ',['танцы'],'.'],['Культура','Весь чат обсуждает финал сериала, а я на третьем сезоне. Не пишите ',['спойлеры'],', пожалуйста.'],['Жизнь','Коллега Б принёс домашние пирожки с подписью «не для ',['Персонажа В'],'». Причину не объясняет.'],['Работа','Начальник поставил созвон на 9:00 в понедельник и опоздал сам. Свидетели есть, ',['скриншоты'],' тоже.']];
const trust=['Никому','не','доверяй.','Каждый','здесь —','«Пользователь».','Коллега.','Сосед.','Бывшая.','Ты.'];
const steps=[['Почта','Вводишь почту и получаешь код.'],['Код','Подтверждаешь — почта тут же удаляется.'],['Ключ','Сохраняешь ключ. Это единственный вход.']];
const ticker=['Все авторы подписаны как «Пользователь»','Почта удаляется сразу после подтверждения','Личные чаты не сохраняются','Никаких реальных имён','Закрытые сообщества — только по приглашению'];

function Logo({big}){return <span className={'logo'+(big?' big':'')}><span className="glitch" data-text="йом">йом</span><svg className="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3 5.3 18.7"/></svg></span>}
function Glitch({children,as:Tag='span',className=''}){return <Tag className={'glitch '+className} data-text={children}>{children}</Tag>}
function Redact({children}){return <span className="redact" tabIndex={0}><span>{children}</span></span>}
function Ticker(){const line=ticker.map(t=>`★ ${t} `).join('');return <div className="ticker" aria-hidden="true"><div><span>{line}</span><span>{line}</span></div></div>}
// Cards land in a loose pile: small sideways offsets and tilts.
const pileX=[-60,50,-30,70,-50,30],pileR=[-3,2,-1.5,2.5,-2,1];
const stamp=i=>`0${2+i}.11.26(${['пн','вт','ср','чт','пт','сб'][i]})${String(9+i*2).padStart(2,'0')}:${String(13+i*7).padStart(2,'0')}`;

function ThemeToggle(){const[theme,setTheme]=useState(document.documentElement.dataset.theme);useEffect(()=>{document.documentElement.dataset.theme=theme;document.querySelector('meta[name=theme-color]').content=theme==='dark'?'#1B1612':'#FDF8EB';try{localStorage.setItem('iom:landing-theme',theme)}catch{}},[theme]);return <button className="icon-button" aria-label={theme==='dark'?'Светлая тема':'Тёмная тема'} onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?<Sun size={18}/>:<Moon size={18}/>}</button>}

// Page scroll feeds the vignette and progress bar; every .scene gets its own 0..1 progress in --p.
function useScrollVars(){useEffect(()=>{let frame=0;const update=()=>{frame=0;const root=document.documentElement;const max=root.scrollHeight-innerHeight;root.style.setProperty('--scroll',max>0?(scrollY/max).toFixed(4):'0');for(const s of document.querySelectorAll('.scene')){const r=s.getBoundingClientRect();s.style.setProperty('--p',Math.min(1,Math.max(0,-r.top/Math.max(1,r.height-innerHeight))).toFixed(4))}};const on=()=>{if(!frame)frame=requestAnimationFrame(update)};update();addEventListener('scroll',on,{passive:true});addEventListener('resize',on);return()=>{removeEventListener('scroll',on);removeEventListener('resize',on);cancelAnimationFrame(frame)}},[])}
// Blocks sharpen into view once, as they scroll in.
function useReveal(){useEffect(()=>{const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.25});document.querySelectorAll('.reveal').forEach(el=>io.observe(el));return()=>io.disconnect()},[])}
// Every so often the page flinches: a short contrast flash, like a camera shutter.
function useFlinch(){useEffect(()=>{if(calm())return;let timer;const main=document.querySelector('main');const next=()=>{timer=setTimeout(()=>{main.classList.add('flinch');setTimeout(()=>main.classList.remove('flinch'),180);next()},6000+Math.random()*7000)};next();return()=>clearTimeout(timer)},[])}

// The hero is fogged except where the visitor looks; without a mouse the clear spot wanders on its own.
function Hero(){const ref=useRef(null);useEffect(()=>{const el=ref.current;const move=e=>{const r=el.getBoundingClientRect();el.classList.add('tracking');el.style.setProperty('--mx',`${((e.clientX-r.left)/r.width*100).toFixed(1)}%`);el.style.setProperty('--my',`${((e.clientY-r.top)/r.height*100).toFixed(1)}%`)};el.addEventListener('pointermove',move);return()=>el.removeEventListener('pointermove',move)},[]);
return <header className="hero" ref={ref}><div className="whispers" aria-hidden="true">{whispers.map((w,i)=><span key={i} style={{left:`${(i*37+11)%88+2}%`,top:`${(i*53+7)%84+6}%`,fontSize:`${14+(i*7)%16}px`,'--d':`${(i%6)*.7}s`}}>{w}</span>)}</div><div className="fog" aria-hidden="true"/><div className="scanlines" aria-hidden="true"/>
<div className="hero-inner"><span className="sticker">18+</span><Logo big/><p className="slogan">исключительно общественное мнение</p><h1>Здесь все сплетничают. <Glitch>Даже ты.</Glitch></h1><p className="lead">Анонимная площадка для историй, которые не расскажешь от своего имени.</p><div className="cta"><a className="primary" href={APP_URL+'/register'}>Войти в ЙОМ</a><a className="ghost" href="#about">Что это такое <ArrowDown size={16}/></a></div></div><span className="scroll-hint" aria-hidden="true">листай, если не боишься</span></header>}

function Eyes(){const ref=useRef(null);useEffect(()=>{if(calm())return;const look=e=>{for(const eye of ref.current.querySelectorAll('.eye')){const r=eye.getBoundingClientRect();const a=Math.atan2(e.clientY-r.top-r.height/2,e.clientX-r.left-r.width/2);eye.style.setProperty('--ex',`${(Math.cos(a)*10).toFixed(1)}px`);eye.style.setProperty('--ey',`${(Math.sin(a)*6).toFixed(1)}px`)}};addEventListener('pointermove',look);return()=>removeEventListener('pointermove',look)},[]);
return <div className="eyes" ref={ref} aria-hidden="true">{[[8,18],[82,12],[16,72],[74,64],[46,86],[90,40],[30,34]].map(([x,y],i)=><span key={i} className="eye" style={{left:`${x}%`,top:`${y}%`,'--blink':`${3+i*1.3}s`}}><i/></span>)}</div>}

function App(){useScrollVars();useReveal();useFlinch();
return <><div className="progress" aria-hidden="true"/><div className="vignette" aria-hidden="true"/><div className="grain" aria-hidden="true"/>
<nav className="topbar"><a href="#top" className="topbar-logo" aria-label="ЙОМ, наверх"><Logo/></a><div className="topbar-links"><a href="#about">О площадке</a><a href="#feed">Лента</a><a href="#join">Как войти</a></div><ThemeToggle/><a className="primary small" href={APP_URL+'/login'}>Войти</a></nav>
<main id="top"><Hero/><Ticker/>
<section className="about" id="about"><h2 className="reveal">Кто такие <Glitch>«Пользователи»</Glitch></h2><p className="reveal lead">ЙОМ — анонимная лента историй и сплетен. Каждый автор подписан одинаково, поэтому за любой сплетней может стоять кто угодно: коллега, сосед, бывшая. Или ты.</p>
<div className="features">{features.map(([Icon,title,text],i)=><article key={title} className="feature reveal" style={{'--i':i}}><span className="feature-icon"><Icon size={22}/></span><b>{title}</b><p>{text}</p></article>)}</div></section>
<section className="scene feed-scene" id="feed"><div className="sticky"><div className="scene-head"><h2>Так выглядит лента</h2><span className="lcd">ПРЯМО СЕЙЧАС</span></div><div className="pile">{posts.map(([topic,...parts],i)=><article key={i} className="post" style={{'--i':i,'--x':pileX[i],'--r':pileR[i]}}><div className="post-top"><b>Пользователь</b><span>{stamp(i)}</span><span>№{1337+i*41}</span></div><span className="topic">{topic}</span><p>{parts.map((p,j)=>Array.isArray(p)?<Redact key={j}>{p[0]}</Redact>:p)}</p></article>)}</div></div></section>
<section className="scene trust-scene"><div className="sticky"><Eyes/><p className="trust">{trust.map((w,i)=><span key={i} style={{'--i':i}} className={i===trust.length-1?'last':''}>{w}</span>)}</p></div></section>
<section className="join" id="join"><h2 className="reveal">Как войти</h2><ol className="steps">{steps.map(([title,text],i)=><li key={title} className="reveal" style={{'--i':i}}><b>{i+1}</b><span><strong>{title}</strong>{text}</span></li>)}</ol></section>
<section className="final reveal"><Glitch as="h2" className="huge">Тебя уже обсуждают</Glitch><p className="lead">Узнай первым, что о тебе пишут. Или напиши сам — никто не узнает.</p><a className="primary big" href={APP_URL+'/register'}>Войти в ЙОМ</a></section></main>
<footer><div className="badges" aria-hidden="true"><span className="b88 b-iom"><b>ЙОМ*</b><i>2026</i></span><span className="b88 b-anon"><b>100%</b><i>анонимно</i></span><span className="b88 b-logs"><b>NO</b><i>LOGS</i></span><span className="b88 b-age"><b>18+</b><i>only</i></span><span className="b88 b-view"><i>лучше всего</i><b>в любом браузере</b></span></div><div className="links"><a href={APP_URL+'/rules'}>Правила платформы</a><a href={APP_URL+'/privacy'}>Политика конфиденциальности</a><a href={APP_URL+'/consent'}>Согласие на обработку данных</a></div><small>ЙОМ* © 2026</small></footer></>}

createRoot(document.getElementById('root')).render(<App/>);
