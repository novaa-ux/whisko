import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createPayment } from './payments/index.js';

const now=()=>new Date().toISOString();
const fail=(status,message)=>Object.assign(new Error(message),{status});
const execute=(db,sql,args=[])=>db.execute({sql,args});
const one=async(db,sql,...args)=>(await execute(db,sql,args)).rows[0]||null;
const all=async(db,sql,...args)=>(await execute(db,sql,args)).rows;
const run=(db,sql,...args)=>execute(db,sql,args);
const send=(res,status,value,headers={})=>{
  const body=Buffer.from(JSON.stringify(value));
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':body.length,
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'no-referrer',
    'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
    ...headers,
  });
  res.end(body);
};
const productRow=row=>({
  id:row.id,
  slug:row.slug,
  name:row.name,
  description:row.description,
  imageUrl:row.image_url,
  pricePiasters:row.price_piasters,
  stock:row.stock,
  active:Boolean(row.active),
  lowStockThreshold:row.low_stock_threshold,
  available:Boolean(row.active)&&row.price_piasters!==null&&row.stock>0,
});
const slugify=value=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70)||'matcha';

function bodyBuffer(req,max=24*1024){
  return new Promise((resolve,reject)=>{
    let size=0;
    let tooLarge=false;
    const chunks=[];
    req.on('data',chunk=>{
      if(tooLarge)return;
      size+=chunk.length;
      if(size>max){
        tooLarge=true;
        reject(fail(413,'The request is too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',()=>{if(!tooLarge)resolve(Buffer.concat(chunks))});
    req.on('error',reject);
  });
}

async function jsonBody(req,max=24*1024){
  const buffer=await bodyBuffer(req,max);
  try{return JSON.parse(buffer.toString('utf8'))}
  catch{throw fail(400,'Enter a valid request body.')}
}

async function multipart(req,max=4*1024*1024){
  const type=req.headers['content-type']||'';
  const boundaryMatch=type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if(!boundaryMatch)throw fail(400,'Use a supported image upload form.');
  const boundary=Buffer.from(`--${boundaryMatch[1]||boundaryMatch[2]}`);
  const input=await bodyBuffer(req,max);
  const fields={};
  let file=null;
  let pos=0;
  while(true){
    const start=input.indexOf(boundary,pos);
    if(start<0)break;
    let partStart=start+boundary.length;
    if(input.subarray(partStart,partStart+2).toString()==='--')break;
    if(input.subarray(partStart,partStart+2).toString()==='\r\n')partStart+=2;
    const headerEnd=input.indexOf(Buffer.from('\r\n\r\n'),partStart);
    if(headerEnd<0)break;
    const headers=input.subarray(partStart,headerEnd).toString('utf8');
    const bodyStart=headerEnd+4;
    const end=input.indexOf(Buffer.concat([Buffer.from('\r\n'),boundary]),bodyStart);
    if(end<0)break;
    const disposition=headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if(disposition){
      const name=disposition[1];
      const filename=disposition[2];
      const data=input.subarray(bodyStart,end);
      if(filename!==undefined){
        if(file)throw fail(400,'Upload one image at a time.');
        file={name:filename,data:Buffer.from(data)};
      }else{
        fields[name]=data.toString('utf8');
      }
    }
    pos=end+2;
  }
  return{fields,file};
}

function parseOptions(options){
  if(!options||typeof options!=='object'||!['iced','hot'].includes(options.temperature)||!['dairy','oat'].includes(options.milk)||!['classic','light','unsweetened'].includes(options.sweetness)){
    throw fail(400,'Choose a valid drink temperature, milk, and sweetness.');
  }
  return{temperature:options.temperature,milk:options.milk,sweetness:options.sweetness};
}

async function toOrder(db,order){
  const items=(await all(db,'SELECT product_name,image_url,unit_price_piasters,quantity,options_json,line_total_piasters FROM order_items WHERE order_id=?',order.id))
    .map(item=>({
      name:item.product_name,
      imageUrl:item.image_url,
      unitPricePiasters:item.unit_price_piasters,
      quantity:item.quantity,
      options:JSON.parse(item.options_json),
      lineTotalPiasters:item.line_total_piasters,
    }));
  return{
    id:order.id,
    code:order.code,
    customer:{name:order.customer_name,phone:order.customer_phone,address:order.delivery_address},
    paymentMethod:order.payment_method,
    status:order.status,
    totalPiasters:order.subtotal_piasters,
    createdAt:order.created_at,
    items,
  };
}

async function transaction(db,callback){
  const tx=await db.transaction('write');
  try{
    const value=await callback(tx);
    await tx.commit();
    return value;
  }catch(error){
    await tx.rollback();
    throw error;
  }
}

function safeEqual(a,b){
  const left=Buffer.from(a);
  const right=Buffer.from(b);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}

function imageType(buffer){
  if(buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff])))return{mime:'image/jpeg'};
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return{mime:'image/png'};
  if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')return{mime:'image/webp'};
  return null;
}

function makePassword(password,salt=crypto.randomBytes(16).toString('hex')){
  const derived=crypto.scryptSync(password,salt,64).toString('hex');
  return`scrypt$${salt}$${derived}`;
}

function checkPassword(password,stored){
  const[,salt,expected]=stored.split('$');
  const actual=crypto.scryptSync(password,salt,64).toString('hex');
  return safeEqual(actual,expected);
}

function productForm(fields,partial=false){
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw fail(400,'Check the product details.');
  const out={};
  for(const key of ['name','description']){
    if(fields[key]!==undefined){
      if(typeof fields[key]!=='string')throw fail(400,`${key==='name'?'Name':'Description'} must be text.`);
      const value=fields[key].trim();
      if(value.length<(key==='name'?2:8)||value.length>(key==='name'?80:500))throw fail(400,`${key==='name'?'Name':'Description'} length is invalid.`);
      out[key]=value;
    }else if(!partial){
      throw fail(400,`Enter a product ${key}.`);
    }
  }
  for(const[key,max]of[['stock',100000],['lowStockThreshold',100000]]){
    if(fields[key]!==undefined){
      if(!/^\d+$/.test(fields[key])||Number(fields[key])>max)throw fail(400,`${key==='stock'?'Stock':'Low stock threshold'} must be a whole number.`);
      out[key]=Number(fields[key]);
    }else if(!partial&&key==='stock'){
      out.stock=0;
    }else if(!partial&&key==='lowStockThreshold'){
      out.lowStockThreshold=5;
    }
  }
  if(fields.pricePiasters!==undefined){
    if(fields.pricePiasters===''){
      out.pricePiasters=null;
    }else if(!/^\d+$/.test(fields.pricePiasters)||Number(fields.pricePiasters)<=0||!Number.isSafeInteger(Number(fields.pricePiasters))){
      throw fail(400,'Set a valid menu price in piasters.');
    }else{
      out.pricePiasters=Number(fields.pricePiasters);
    }
  }else if(!partial){
    out.pricePiasters=null;
  }
  if(fields.active!==undefined){
    if(!['true','false','1','0'].includes(String(fields.active)))throw fail(400,'Choose whether to show this drink on the menu.');
    out.active=['true','1'].includes(String(fields.active));
  }else if(!partial){
    out.active=true;
  }
  return out;
}

async function storeImage(db,file){
  const detected=imageType(file.data);
  if(!detected)throw fail(400,'Choose a valid JPG, PNG, or WebP product image.');
  if(file.data.length>3.5*1024*1024)throw fail(413,'Images must be 3.5 MB or smaller.');
  const id=crypto.randomUUID();
  await run(db,'INSERT INTO product_images(id,mime_type,image_data) VALUES(?,?,?)',id,detected.mime,file.data);
  return`/api/product-images/${id}`;
}

async function removeUnusedStoredImage(db,imageUrl){
  const match=imageUrl.match(/^\/api\/product-images\/([0-9a-f-]{36})$/i);
  if(match){
    await run(db,'DELETE FROM product_images WHERE id=? AND NOT EXISTS (SELECT 1 FROM order_items WHERE image_url=?)',match[1],imageUrl);
  }
}

const transitions={
  pending:['accepted','rejected'],
  accepted:['preparing','rejected','cancelled'],
  preparing:['out_for_delivery','cancelled'],
  out_for_delivery:['completed'],
  rejected:[],
  completed:[],
  cancelled:[],
};

export async function createServer({db,env=process.env,rootDir=process.cwd()}){
  const secret=env.JWT_SECRET;
  if(!secret||secret.length<32)throw new Error('JWT_SECRET must contain at least 32 characters. Configure it in .env before starting the server.');
  if(!env.ADMIN_EMAIL||!env.ADMIN_PASSWORD||env.ADMIN_PASSWORD.length<12||env.ADMIN_PASSWORD.length>200)throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD between 12 and 200 characters in .env before starting the server.');
  if(env.ADMIN_PASSWORD==='replace-this-before-starting')throw new Error('Replace the sample ADMIN_PASSWORD in .env before starting the server.');
  const email=env.ADMIN_EMAIL.trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('ADMIN_EMAIL is not a valid email address.');

  const passwordHash=makePassword(env.ADMIN_PASSWORD);
  await transaction(db,async tx=>{
    const owner=await one(tx,'SELECT id,password_hash FROM admins WHERE email=?',email);
    if(!owner){
      await run(tx,'INSERT INTO admins(id,email,password_hash) VALUES(?,?,?)',crypto.randomUUID(),email,passwordHash);
    }else if(!checkPassword(env.ADMIN_PASSWORD,owner.password_hash)){
      await run(tx,'UPDATE admins SET password_hash=? WHERE id=?',passwordHash,owner.id);
      await run(tx,'DELETE FROM sessions WHERE admin_id=?',owner.id);
    }
  });

  const staticDir=path.join(rootDir,'dist');
  const uploadDir=path.join(rootDir,'public','uploads');
  const limits=new Map();
  function limited(req,key,limit,windowMs){
    const current=Date.now();
    const id=`${key}:${req.socket?.remoteAddress||'unknown'}`;
    const stamp=limits.get(id);
    if(!stamp||current-stamp.started>windowMs){
      limits.set(id,{started:current,count:1,expiresAt:current+windowMs});
      if(limits.size>5000)for(const[entry,value]of limits)if(value.expiresAt<=current)limits.delete(entry);
      return false;
    }
    stamp.count++;
    return stamp.count>limit;
  }
  function checkOrigin(req){
    const origin=req.headers.origin;
    if(!origin)return;
    let normalizedOrigin;
    try{
      const parsed=new URL(origin);
      if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin)throw new Error();
      normalizedOrigin=parsed.origin;
    }catch{
      throw fail(403,'Request origin is not allowed.');
    }
    const requestProtocol=env.VERCEL?'https':req.socket?.encrypted?'https':'http';
    const allowedOrigins=[`${requestProtocol}://${req.headers.host}`];
    if(env.APP_ORIGIN){
      try{allowedOrigins.push(new URL(env.APP_ORIGIN).origin)}catch{}
    }
    if(!allowedOrigins.includes(normalizedOrigin))throw fail(403,'Request origin is not allowed.');
  }
  async function getAdmin(req){
    checkOrigin(req);
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('whisko_admin='))?.slice('whisko_admin='.length);
    if(!cookie||!/^[A-Za-z0-9_-]{43}$/.test(cookie))throw fail(401,'Please sign in to the WHISKO dashboard.');
    const tokenHash=crypto.createHash('sha256').update(cookie).digest('hex');
    const row=await one(db,'SELECT admins.id,admins.email FROM sessions JOIN admins ON admins.id=sessions.admin_id WHERE sessions.token_hash=? AND sessions.expires_at>?',tokenHash,now());
    if(!row)throw fail(401,'Please sign in to the WHISKO dashboard.');
    return{id:row.id,email:row.email};
  }
  function sessionCookie(value,clear=false){
    const secure=env.NODE_ENV==='production'?'; Secure':'';
    return`whisko_admin=${clear?'':encodeURIComponent(value)}; Path=/api/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=${clear?0:28800}`;
  }

  async function route(req,res){
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    let pathname;
    try{pathname=decodeURIComponent(url.pathname)}
    catch{throw fail(400,'The request path is invalid.')}
    const method=req.method||'GET';

    if(method==='GET'&&pathname==='/api/health'){
      await one(db,'SELECT 1 AS connected');
      return send(res,200,{ok:true,service:'whisko-api',database:'connected'});
    }
    if(method==='GET'&&pathname==='/api/products'){
      const products=(await all(db,'SELECT * FROM products WHERE active=1 ORDER BY position,name')).map(productRow);
      return send(res,200,{products});
    }
    let match=pathname.match(/^\/api\/products\/([a-z0-9-]+)$/);
    if(method==='GET'&&match){
      const row=await one(db,'SELECT * FROM products WHERE slug=? AND active=1',match[1]);
      if(!row)throw fail(404,'That matcha is not on the menu.');
      return send(res,200,{product:productRow(row)});
    }
    match=pathname.match(/^\/api\/product-images\/([0-9a-f-]{36})$/i);
    if(method==='GET'&&match){
      const image=await one(db,'SELECT mime_type,image_data FROM product_images WHERE id=?',match[1]);
      if(!image)throw fail(404,'Product image not found.');
      const body=Buffer.from(image.image_data);
      res.writeHead(200,{
        'Content-Type':image.mime_type,
        'Content-Length':body.length,
        'Cache-Control':'public, max-age=31536000, immutable',
        'X-Content-Type-Options':'nosniff',
        'X-Frame-Options':'DENY',
        'Referrer-Policy':'no-referrer',
      });
      return res.end(body);
    }
    if(method==='POST'&&pathname==='/api/orders'){
      if(limited(req,'order',12,600000))throw fail(429,'Please wait before placing another order.');
      const body=await jsonBody(req);
      if(!body||typeof body!=='object'||Array.isArray(body)||!body.customer||typeof body.customer!=='object'||!Array.isArray(body.items)||!body.items.length||body.items.length>20)throw fail(400,'Check the customer and order details.');
      if(typeof body.customer.name!=='string'||typeof body.customer.phone!=='string'||typeof body.customer.address!=='string')throw fail(400,'Enter your name, phone number, and delivery address.');
      const customer={name:body.customer.name.trim(),phone:body.customer.phone.trim(),address:body.customer.address.trim()};
      if(customer.name.length<2||customer.name.length>100)throw fail(400,'Enter a valid name.');
      if(!/^\+?[0-9][0-9\s()\-.]{6,22}$/.test(customer.phone))throw fail(400,'Enter a valid phone number.');
      if(customer.address.length<10||customer.address.length>500)throw fail(400,'Enter a delivery address with at least 10 characters.');
      if(body.paymentMethod!=='cash_on_delivery')throw fail(400,'Cash on delivery is the available payment method.');
      const seen=new Set();
      const items=body.items.map(item=>{
        if(!item||typeof item.productId!=='string'||!(/^[0-9a-f-]{36}$/i.test(item.productId)))throw fail(400,'Refresh your bag and check the selected drinks.');
        if(seen.has(item.productId))throw fail(400,'Remove duplicate drinks from your bag.');
        seen.add(item.productId);
        if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>20)throw fail(400,'Choose a valid quantity.');
        return{productId:item.productId,quantity:item.quantity,options:parseOptions(item.options)};
      });
      const token=crypto.randomBytes(32).toString('base64url');
      const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
      const id=crypto.randomUUID();
      const code=`WSK-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      let total=0;
      await transaction(db,async tx=>{
        const selected=[];
        for(const item of items){
          const product=await one(tx,'SELECT * FROM products WHERE id=? AND active=1',item.productId);
          if(!product)throw fail(409,'A matcha in your bag is no longer on the menu. Refresh your bag.');
          if(product.price_piasters===null)throw fail(409,`${product.name} is not available to order yet. Please check back soon.`);
          if(product.stock<item.quantity)throw fail(409,`${product.name} does not have enough stock for that quantity.`);
          const line=product.price_piasters*item.quantity;
          if(!Number.isSafeInteger(line)||!Number.isSafeInteger(total+line))throw fail(400,'The order total is too large.');
          total+=line;
          selected.push({product,item,line});
        }
        const payment=createPayment(body.paymentMethod,{amountPiasters:total});
        if(payment.method!=='cash_on_delivery')throw fail(400,'Payment method is unavailable.');
        await run(tx,`INSERT INTO orders(id,code,confirmation_token_hash,customer_name,customer_phone,delivery_address,payment_method,status,subtotal_piasters)
          VALUES(?,?,?,?,?,?,'cash_on_delivery','pending',?)`,id,code,tokenHash,customer.name,customer.phone,customer.address,total);
        for(const{product,item,line}of selected){
          const changed=await run(tx,'UPDATE products SET stock=stock-?,updated_at=? WHERE id=? AND stock>=?',item.quantity,now(),product.id,item.quantity);
          if(changed.rowsAffected!==1)throw fail(409,`${product.name} has just sold out. Refresh your bag.`);
          await run(tx,'INSERT INTO order_items(id,order_id,product_id,product_name,image_url,unit_price_piasters,quantity,options_json,line_total_piasters) VALUES(?,?,?,?,?,?,?,?,?)',crypto.randomUUID(),id,product.id,product.name,product.image_url,product.price_piasters,item.quantity,JSON.stringify(item.options),line);
        }
      });
      return send(res,201,{order:{code,confirmationToken:token,totalPiasters:total,status:'pending',paymentMethod:'cash_on_delivery'}});
    }
    match=pathname.match(/^\/api\/orders\/([A-Z0-9-]+)$/);
    if(method==='GET'&&match){
      const token=url.searchParams.get('token')||'';
      const order=await one(db,'SELECT * FROM orders WHERE code=?',match[1]);
      if(!order||token.length>100||!safeEqual(order.confirmation_token_hash,crypto.createHash('sha256').update(token).digest('hex')))throw fail(404,'Order confirmation not found.');
      return send(res,200,{order:await toOrder(db,order)});
    }
    if(pathname.startsWith('/api/admin/')){
      if(method==='POST'&&pathname==='/api/admin/login'){
        if(limited(req,'login',8,900000))throw fail(429,'Too many sign-in attempts. Try again in a little while.');
        checkOrigin(req);
        const body=await jsonBody(req);
        if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Enter your email and password.');
        const loginEmail=String(body.email||'').trim().toLowerCase();
        const password=String(body.password||'');
        if(loginEmail.length>254||password.length>200)throw fail(400,'Enter your email and password.');
        const user=await one(db,'SELECT * FROM admins WHERE email=?',loginEmail);
        const dummy='scrypt$00112233445566778899aabbccddeeff$'.concat(crypto.scryptSync('not-a-real-password','00112233445566778899aabbccddeeff',64).toString('hex'));
        const correct=checkPassword(password,user?.password_hash||dummy);
        if(!user||!correct)throw fail(401,'Email or password is incorrect.');
        const token=crypto.randomBytes(32).toString('base64url');
        const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
        await run(db,'DELETE FROM sessions WHERE expires_at<=?',now());
        await run(db,'INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)',tokenHash,user.id,new Date(Date.now()+8*60*60*1000).toISOString());
        return send(res,200,{admin:{email:user.email}},{'Set-Cookie':sessionCookie(token)});
      }
      if(method==='POST'&&pathname==='/api/admin/logout'){
        await getAdmin(req);
        const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('whisko_admin='))?.slice('whisko_admin='.length);
        if(cookie)await run(db,'DELETE FROM sessions WHERE token_hash=?',crypto.createHash('sha256').update(cookie).digest('hex'));
        return send(res,200,{ok:true},{'Set-Cookie':sessionCookie('',true)});
      }
      const admin=await getAdmin(req);
      if(method==='GET'&&pathname==='/api/admin/me')return send(res,200,{admin});
      if(method==='GET'&&pathname==='/api/admin/dashboard'){
        const [counts,orderRows,productRows,orderCount,pendingCount,productCount,sales]=await Promise.all([
          all(db,'SELECT status,COUNT(*) AS count FROM orders GROUP BY status'),
          all(db,'SELECT * FROM orders ORDER BY created_at DESC'),
          all(db,'SELECT * FROM products ORDER BY position,name'),
          one(db,'SELECT COUNT(*) AS n FROM orders'),
          one(db,"SELECT COUNT(*) AS n FROM orders WHERE status='pending'"),
          one(db,'SELECT COUNT(*) AS n FROM products'),
          one(db,"SELECT COALESCE(SUM(subtotal_piasters),0) AS n FROM orders WHERE status IN ('accepted','preparing','out_for_delivery','completed')"),
        ]);
        const products=productRows.map(productRow);
        const orders=await Promise.all(orderRows.map(order=>toOrder(db,order)));
        const stats={
          orders:Number(orderCount.n),
          pending:Number(pendingCount.n),
          products:Number(productCount.n),
          salesPiasters:Number(sales.n),
          statusCounts:Object.fromEntries(counts.map(row=>[row.status,Number(row.count)])),
        };
        return send(res,200,{stats,orders,products,lowStock:products.filter(product=>product.stock<=product.lowStockThreshold)});
      }
      if(method==='GET'&&pathname==='/api/admin/products'){
        const products=(await all(db,'SELECT * FROM products ORDER BY name')).map(productRow);
        return send(res,200,{products});
      }
      if(method==='POST'&&pathname==='/api/admin/products'){
        const form=await multipart(req);
        const data=productForm(form.fields);
        if(!form.file)throw fail(400,'Add an individual product image.');
        const id=crypto.randomUUID();
        let imageUrl;
        await transaction(db,async tx=>{
          imageUrl=await storeImage(tx,form.file);
          let slug=slugify(data.name);
          let suffix=1;
          while(await one(tx,'SELECT id FROM products WHERE slug=?',slug))slug=`${slugify(data.name)}-${++suffix}`;
          const position=Number((await one(tx,'SELECT COALESCE(MAX(position),-1)+1 AS p FROM products')).p);
          await run(tx,'INSERT INTO products(id,slug,name,description,image_url,position,price_piasters,stock,active,low_stock_threshold) VALUES(?,?,?,?,?,?,?,?,?,?)',id,slug,data.name,data.description,imageUrl,position,data.pricePiasters,data.stock,Number(data.active),data.lowStockThreshold);
        });
        return send(res,201,{product:productRow(await one(db,'SELECT * FROM products WHERE id=?',id))});
      }
      match=pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
      if(match&&method==='PATCH'){
        const form=(req.headers['content-type']||'').includes('multipart/form-data')
          ? await multipart(req)
          : {fields:await jsonBody(req),file:null};
        const data=productForm(form.fields,true);
        const updated=await transaction(db,async tx=>{
          const old=await one(tx,'SELECT * FROM products WHERE id=?',match[1]);
          if(!old)throw fail(404,'Product not found.');
          const imageUrl=form.file?await storeImage(tx,form.file):old.image_url;
          let slug=old.slug;
          if(data.name&&data.name!==old.name){
            slug=slugify(data.name);
            let suffix=1;
            while(await one(tx,'SELECT id FROM products WHERE slug=? AND id<>?',slug,old.id))slug=`${slugify(data.name)}-${++suffix}`;
          }
          await run(tx,'UPDATE products SET slug=?,name=?,description=?,image_url=?,price_piasters=?,stock=?,active=?,low_stock_threshold=?,updated_at=? WHERE id=?',slug,data.name??old.name,data.description??old.description,imageUrl,data.pricePiasters===undefined?old.price_piasters:data.pricePiasters,data.stock??old.stock,data.active===undefined?old.active:Number(data.active),data.lowStockThreshold??old.low_stock_threshold,now(),old.id);
          if(imageUrl!==old.image_url)await removeUnusedStoredImage(tx,old.image_url);
          return old;
        });
        if(form.file&&updated.image_url.startsWith('/uploads/')){
          const oldFile=path.join(uploadDir,path.basename(updated.image_url));
          try{await fs.unlink(oldFile)}catch(error){if(error.code!=='ENOENT')throw error}
        }
        return send(res,200,{product:productRow(await one(db,'SELECT * FROM products WHERE id=?',match[1]))});
      }
      if(match&&method==='DELETE'){
        const removed=await transaction(db,async tx=>{
          const product=await one(tx,'SELECT * FROM products WHERE id=?',match[1]);
          if(!product)throw fail(404,'Product not found.');
          await run(tx,'DELETE FROM products WHERE id=?',product.id);
          await removeUnusedStoredImage(tx,product.image_url);
          return product;
        });
        if(removed.image_url.startsWith('/uploads/')){
          const oldFile=path.join(uploadDir,path.basename(removed.image_url));
          try{await fs.unlink(oldFile)}catch(error){if(error.code!=='ENOENT')throw error}
        }
        return send(res,200,{ok:true});
      }
      match=pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/status$/i);
      if(method==='PATCH'&&match){
        const body=await jsonBody(req);
        if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Choose a valid order status.');
        const allowed=['accepted','rejected','preparing','out_for_delivery','completed','cancelled'];
        if(!allowed.includes(body.status))throw fail(400,'Choose a valid order status.');
        await transaction(db,async tx=>{
          const order=await one(tx,'SELECT * FROM orders WHERE id=?',match[1]);
          if(!order)throw fail(404,'Order not found.');
          if(!transitions[order.status]?.includes(body.status))throw fail(409,`An order cannot move from ${order.status.replaceAll('_',' ')} to ${body.status.replaceAll('_',' ')}.`);
          if(['rejected','cancelled'].includes(body.status)&&!order.stock_released){
            const lines=await all(tx,'SELECT product_id,quantity FROM order_items WHERE order_id=?',order.id);
            for(const line of lines)if(line.product_id)await run(tx,'UPDATE products SET stock=stock+?,updated_at=? WHERE id=?',line.quantity,now(),line.product_id);
            await run(tx,'UPDATE orders SET stock_released=1 WHERE id=?',order.id);
          }
          await run(tx,'UPDATE orders SET status=?,updated_at=? WHERE id=?',body.status,now(),order.id);
        });
        return send(res,200,{order:await toOrder(db,await one(db,'SELECT * FROM orders WHERE id=?',match[1]))});
      }
      throw fail(404,'Not found.');
    }
    if(pathname.startsWith('/api/'))throw fail(404,'Not found.');
    if(method!=='GET'&&method!=='HEAD')throw fail(404,'Not found.');
    if(pathname.startsWith('/uploads/'))return staticFile(res,path.join(uploadDir,path.basename(pathname)),method);
    return staticFile(res,path.join(staticDir,pathname==='/'?'index.html':pathname.replace(/^\//,'')),method,true);
  }

  async function staticFile(res,file,method,spa=false){
    const base=spa?staticDir:uploadDir;
    const resolved=path.resolve(file);
    if(!resolved.startsWith(base+path.sep)&&resolved!==base)throw fail(404,'Not found.');
    let actual=resolved;
    try{
      const info=await fs.stat(actual);
      if(info.isDirectory())actual=path.join(actual,'index.html');
      await fs.access(actual);
    }catch{
      if(spa&&!path.extname(resolved))actual=path.join(staticDir,'index.html');
      else throw fail(404,'Not found.');
    }
    const ext=path.extname(actual).toLowerCase();
    const mime={
      '.html':'text/html; charset=utf-8',
      '.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8',
      '.svg':'image/svg+xml',
      '.png':'image/png',
      '.jpg':'image/jpeg',
      '.jpeg':'image/jpeg',
      '.webp':'image/webp',
      '.ico':'image/x-icon',
      '.woff2':'font/woff2',
    }[ext]||'application/octet-stream';
    const body=method==='HEAD'?null:await fs.readFile(actual);
    res.writeHead(200,{
      'Content-Type':mime,
      'Content-Length':body?.length||0,
      'X-Content-Type-Options':'nosniff',
      'X-Frame-Options':'DENY',
      'Referrer-Policy':'no-referrer',
      'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
      'Cache-Control':ext==='.html'?'no-cache':'public, max-age=86400',
      'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  return http.createServer((req,res)=>{
    route(req,res).catch(error=>{
      if(res.headersSent){res.destroy();return}
      const status=error.status||500;
      if(status>=500)console.error(`${now()} ${req.method} ${req.url}: ${error.stack||error.message}`);
      send(res,status,{error:status===500?'Something went wrong. Please try again.':error.message});
    });
  });
}
