import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../server/db.js';
import { createServer } from '../server/app.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let serverPromise;

async function getServer(){
  if(!process.env.TURSO_DATABASE_URL||!process.env.TURSO_AUTH_TOKEN){
    throw new Error('Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Vercel project settings.');
  }
  if(!serverPromise){
    serverPromise=(async()=>{
      const db=await createDatabase({
        url:process.env.TURSO_DATABASE_URL,
        authToken:process.env.TURSO_AUTH_TOKEN,
      });
      try{
        return await createServer({db,env:process.env,rootDir:root});
      }catch(error){
        await db.close();
        throw error;
      }
    })().catch(error=>{
      serverPromise=undefined;
      throw error;
    });
  }
  return serverPromise;
}

export default async function handler(req,res){
  let server;
  try{
    server=await getServer();
  }catch(error){
    console.error('WHISKO Vercel function initialization failed:',error);
    res.statusCode=503;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.end(JSON.stringify({error:'The API could not start. Check the Vercel function logs and database environment settings.'}));
    return;
  }
  await new Promise((resolve,reject)=>{
    res.once('finish',resolve);
    res.once('close',resolve);
    res.once('error',reject);
    server.emit('request',req,res);
  });
}
