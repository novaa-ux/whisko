import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { createServer } from './app.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const envFile=path.join(root,'.env');
if(fs.existsSync(envFile)){
  if(typeof process.loadEnvFile!=='function')throw new Error('Your Node.js version does not support process.loadEnvFile. Update Node.js to a recent LTS version.');
  process.loadEnvFile(envFile);
}

const port=Number(process.env.PORT||4000);
const host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be a whole number between 1 and 65535.');

const dbFile=path.resolve(root,process.env.DATABASE_PATH||'./data/whisko.sqlite');
const databaseOptions=process.env.TURSO_DATABASE_URL
  ? {url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN}
  : {filename:dbFile};
if(Boolean(process.env.TURSO_DATABASE_URL)!==Boolean(process.env.TURSO_AUTH_TOKEN))throw new Error('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to use Turso.');
if(!databaseOptions.url)fs.mkdirSync(path.dirname(dbFile),{recursive:true});
const db=await createDatabase(databaseOptions);
const server=await createServer({db,env:process.env,rootDir:root});
server.listen(port,host,()=>console.log(`WHISKO API listening on http://${host}:${port}`));

let shuttingDown=false;
function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;
  console.log(`${signal} received; closing WHISKO.`);
  const timeout=setTimeout(()=>process.exit(1),10000);
  timeout.unref();
  server.close(()=>{
    clearTimeout(timeout);
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
