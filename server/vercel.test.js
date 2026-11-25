import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

test('Vercel catch-all serves the catalog and reports missing database settings',async t=>{
  const original=Object.fromEntries([
    'TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','JWT_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD','APP_ORIGIN','NODE_ENV',
  ].map(key=>[key,process.env[key]]));
  Object.assign(process.env,{
    TURSO_DATABASE_URL:'file::memory:',
    TURSO_AUTH_TOKEN:'test-token',
    JWT_SECRET:crypto.randomBytes(48).toString('hex'),
    ADMIN_EMAIL:'owner@whisko.test',
    ADMIN_PASSWORD:'whisko-test-password-2026',
    APP_ORIGIN:'https://whisko-matcha.vercel.app',
    NODE_ENV:'production',
  });

  const {default:handler}=await import('../api/[...path].js');
  const server=http.createServer((req,res)=>{
    handler(req,res).catch(error=>{
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:error.message}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    for(const[key,value]of Object.entries(original)){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
  });

  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/api/products`);
  assert.equal(response.status,200);
  const {products}=await response.json();
  assert.equal(products.length,10);
  assert.equal(products[0].slug,'classic-matcha');

  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const missingConfig=await fetch(`${base}/api/products`);
  assert.equal(missingConfig.status,503);
  assert.match((await missingConfig.json()).error,/Vercel function logs and database environment settings/);
});
