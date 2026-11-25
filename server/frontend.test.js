import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { createServer } from './app.js';

test('production server connects the built WHISKO site to its ten local product photos',async t=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'whisko-production-'));
 const db=await createDatabase({url:'file::memory:'});
 const server=await createServer({db,env:{NODE_ENV:'production',JWT_SECRET:crypto.randomBytes(48).toString('hex'),ADMIN_EMAIL:'owner@whisko.test',ADMIN_PASSWORD:'whisko-test-password-2026'},rootDir:root});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();await fs.rm(temp,{recursive:true,force:true})});
 const home=await fetch(base);assert.equal(home.status,200);assert.match(home.headers.get('content-type'),/text\/html/);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);const html=await home.text();assert.match(html,/WHISKO Café/);const asset=html.match(/src="([^"]+\.js)"/);assert.ok(asset,'built app JavaScript is referenced');assert.equal((await fetch(base+asset[1])).status,200);
 const adminPage=await fetch(base+'/admin');assert.equal(adminPage.status,200);assert.match(await adminPage.text(),/WHISKO Café/);
 const route=await fetch(base+'/products/classic-matcha');assert.equal(route.status,200);assert.match(route.headers.get('content-type'),/text\/html/);
 const catalog=await fetch(base+'/api/products');const data=await catalog.json();assert.equal(data.products.length,10);
 for(const product of data.products){const image=await fetch(base+product.imageUrl);assert.equal(image.status,200,`${product.name} photo is deployed`);assert.match(image.headers.get('content-type'),/image\/jpeg/);assert.ok(Number(image.headers.get('content-length'))>10000)}
 const hero=await fetch(base+'/whisko-homepage.png');assert.equal(hero.status,200);assert.match(hero.headers.get('content-type'),/image\/png/);
 const bowl=await fetch(base+'/matcha-bowl.png');assert.equal(bowl.status,200);assert.match(bowl.headers.get('content-type'),/image\/png/);assert.ok(Number(bowl.headers.get('content-length'))>100000);
});
