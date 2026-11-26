import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../server/db.js';
import { createServer } from '../server/app.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let serverPromise;

async function getServer(){
  const missingDatabaseSettings=['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN'].filter(name=>!process.env[name]);
  if(missingDatabaseSettings.length){
    throw Object.assign(new Error('Missing required Vercel database environment variables.'),{missingDatabaseSettings});
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
    const missing=error.missingDatabaseSettings;
    res.end(JSON.stringify({error:missing?.length
      ? `Add these variables in Vercel Project Settings > Environment Variables: ${missing.join(', ')}.`
      : 'The API database could not connect. Check the Vercel function logs and confirm the Turso URL and token are valid.'}));
    return;
  }
  await new Promise((resolve,reject)=>{
    res.once('finish',resolve);
    res.once('close',resolve);
    res.once('error',reject);
    server.emit('request',req,res);
  });
}
