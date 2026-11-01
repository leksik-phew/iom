import nodemailer from 'nodemailer';
export const devMail=process.env.NODE_ENV!=='production'&&!process.env.SMTP_HOST;
export const mail=process.env.SMTP_HOST?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined}):null;
export const supportEmail=process.env.SUPPORT_EMAIL||'g652219@yandex.ru';
