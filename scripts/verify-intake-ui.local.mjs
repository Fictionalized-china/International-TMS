// Local-only browser verification, temporary sessions only. Never advances an existing order.
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
const folder=resolve('.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const file=readdirSync(folder).find(name=>name.endsWith('.sqlite')&&name!=='metadata.sqlite');
if (!file) throw new Error('未找到本地数据库');
const db=new DatabaseSync(resolve(folder,file)); db.exec('PRAGMA busy_timeout=5000');
if(process.argv.includes('--accounts')) {
 console.log(JSON.stringify(db.prepare(`SELECT u.email,u.display_name,p.code position_code,m.status
   FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN positions p ON p.id=m.position_id
   WHERE u.status='active' AND m.status='active' ORDER BY p.code,u.email`).all(),null,2));
 db.close();process.exit(0);
}
const member=db.prepare(`SELECT m.user_id,m.organization_id FROM memberships m JOIN users u ON u.id=m.user_id
 JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
 WHERE m.status='active' AND u.status='active' AND p.code='SALES' AND u.email LIKE '%@e2e.test' LIMIT 1`).get();
if(!member) throw new Error('无本地业务测试账号');
const id=randomUUID(),slot=randomUUID(),token=randomBytes(32).toString('base64url'),now=new Date().toISOString();
db.prepare("INSERT INTO sessions(id,user_id,organization_id,token_hash,expires_at,last_seen_at,created_at,site) VALUES(?,?,?,?,?,?,?,'admin')")
 .run(id,member.user_id,member.organization_id,createHash('sha256').update(token).digest('hex'),new Date(Date.now()+600000).toISOString(),now,now);
try {
 const code=`async (page) => {
   await page.context().addCookies([{name:${JSON.stringify('itms_admin_session_'+slot)},value:${JSON.stringify(token)},url:'http://127.0.0.1:5189',httpOnly:true,sameSite:'Lax'}]);
   await page.goto(${JSON.stringify('http://127.0.0.1:5189/admin/quotations?entryMode=direct&itmsTab='+slot)});
   await page.getByRole('dialog').waitFor({state:'visible'});
   const dialog=page.getByRole('dialog'), wizard=dialog.locator('.intake-step-layout');
   const check=(condition,message)=>{if(!condition)throw new Error(message);};
   await dialog.getByRole('button',{name:'下一步 →',exact:true}).click();
   check(await wizard.getAttribute('data-active-step')==='0','缺订单类型必须留在步骤1');
   await dialog.locator('[name="roadLoadType"]').selectOption('ltl');
   const fillRequired=async(step)=>{
     if(step===1) {
       const pickers=dialog.locator('[data-intake-step="1"] .quote-geo-picker');
       for(let i=0;i<await pickers.count();i++) {
         const picker=pickers.nth(i); if(await picker.locator('select').last().inputValue())continue;
         const trigger=picker.locator('.quote-geo-trigger');
         if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
         for(const label of ['1  国家 / 地区','2  省 / 州','3  城市']) {
           await picker.getByRole('listbox',{name:label,exact:true}).getByRole('option').first().click();
         }
       }
     }
     for(let pass=0;pass<3;pass++) {
     const controls=dialog.locator('[data-intake-step="'+step+'"] input,[data-intake-step="'+step+'"] select,[data-intake-step="'+step+'"] textarea');
     for(let i=0;i<await controls.count();i++) {
       const control=controls.nth(i); if(!await control.isVisible() || !await control.isEnabled())continue;
       const info=await control.evaluate(el=>({tag:el.tagName,required:el.required,readOnly:el.readOnly,type:el.type,value:el.value}));
       if(!info.required||info.readOnly||info.value||['hidden','file','checkbox','radio'].includes(info.type))continue;
       if(info.tag==='SELECT') {
         const option=await control.evaluate(el=>[...el.options].find(o=>o.value&&!o.disabled)?.value);
         if(option) await control.selectOption(option);
       } else await control.fill(info.type==='number'?'12':'本地界面验收，不保存');
     }
     }
   };
   await fillRequired(0);
   await page.screenshot({path:'output/playwright/intake-step-1.png'});
   for(const step of [1,2,3]) {
     await dialog.getByRole('button',{name:'下一步 →',exact:true}).click();
     try {await dialog.locator('.intake-step-layout[data-active-step="'+step+'"]').waitFor({timeout:2000});}
     catch {throw new Error('步骤切换失败 '+step+' '+JSON.stringify(await dialog.locator('input,select,textarea').evaluateAll(items=>items.filter(el=>el.willValidate&&!el.validity.valid).map(el=>({name:el.name,value:el.value,message:el.validationMessage})))));}
     if(step<3) await fillRequired(step);
   }
   const ar=dialog.locator('[data-intake-step="3"]');
   await ar.locator('[name="chargeQuantity"]').fill('3');
   await ar.locator('[name="chargeUnitPrice"]').fill('12.35');
   for(let i=0;i<6;i++) {
     await ar.getByRole('button',{name:'＋ 新增费用明细',exact:true}).click();
     const row=ar.locator('tr[data-fee-index]').last();
     await row.locator('select').selectOption({label:'包装费'});
     await row.locator('[name="chargeQuantity"]').fill('2');
     await row.locator('[name="chargeUnitPrice"]').fill('10');
   }
   check(await ar.locator('.intake-fee-summary').innerText().then(t=>t.includes('157.05')),'应收自动合计错误');
   check(await ar.locator('tr[data-fee-index]:visible').count()===2,'费用分页显示错误');
   await page.screenshot({path:'output/playwright/intake-receivable.png'});
   await dialog.getByRole('button',{name:'下一步 →',exact:true}).click();
   check(await wizard.getAttribute('data-active-step')==='4','不能进入应付步骤');
   const ap=dialog.locator('[data-intake-step="4"]');
   await ap.getByRole('button',{name:'＋ 提货费',exact:true}).click();
   await ap.locator('[name="intakePayableUnitPrice"]').fill('0');
   await ap.locator('[name="intakePayableCounterparty"]').fill('客户自送');
   for(const [qty,price,party] of [['2','10','供应商甲'],['3','2','供应商乙']]) {
     await ap.getByRole('button',{name:'＋ 新增费用明细',exact:true}).click();
     const row=ap.locator('tr[data-fee-index]').last();
     await row.locator('select').selectOption({label:'打包费'});
     await row.locator('[name="intakePayableQuantity"]').fill(qty);
     await row.locator('[name="intakePayableUnitPrice"]').fill(price);
     await row.locator('[name="intakePayableCounterparty"]').fill(party);
   }
   check(await ap.locator('.intake-fee-summary').innerText().then(t=>t.includes('26.00')),'应付合计错误');
   await page.screenshot({path:'output/playwright/intake-payable.png'});
   const payload=await dialog.locator('form.prototype-quote-form').evaluate(form=>{
     const data=new FormData(form);return{ar:data.getAll('chargeName').length,prices:data.getAll('chargeUnitPrice'),ap:data.getAll('intakePayableCode').length,parties:data.getAll('intakePayableCounterparty')};
   });
   check(payload.ar===7&&payload.ap===3&&payload.prices[0]==='12.35','分页隐藏值没有完整提交');
   await dialog.getByRole('button',{name:'上一步',exact:true}).click();
   await dialog.getByRole('button',{name:'下一步 →',exact:true}).click();
   check(await ap.locator('[name="intakePayableUnitPrice"]').nth(2).inputValue()==='2','切换步骤丢失金额');
   // Stop all writes. Native submit exercises the actual capture validation, not a test-only helper.
   await dialog.locator('form.prototype-quote-form').evaluate(form=>{
     window.__intakeSubmitCount=0;form.addEventListener('submit',event=>{if(!event.defaultPrevented){window.__intakeSubmitCount++;event.preventDefault();}});
     form.querySelector('[name="chargeUnitPrice"]').setCustomValidity('隐藏页金额校验测试');
   });
   await dialog.getByRole('button',{name:'确认资料并建立订单',exact:true}).click();
   check(await wizard.getAttribute('data-active-step')==='3','提交未跳回隐藏的错误费用步骤');
   check(await ar.locator('tr[data-fee-index="0"]').isVisible(),'未定位第一页错误费用');
   check(await page.evaluate(()=>window.__intakeSubmitCount)===0,'无效表单被提交');
   await dialog.locator('[name="chargeUnitPrice"]').first().evaluate(el=>el.setCustomValidity(''));
   await dialog.getByRole('button',{name:'下一步 →',exact:true}).click();
   await dialog.getByRole('button',{name:'确认资料并建立订单',exact:true}).click();
   check(await page.evaluate(()=>window.__intakeSubmitCount)===1,'有效表单未通过校验 '+JSON.stringify(await dialog.locator('form.prototype-quote-form').evaluate(form=>({step:form.querySelector('.intake-step-layout').dataset.activeStep,invalid:[...form.querySelectorAll('input,select,textarea')].filter(el=>el.willValidate&&!el.validity.valid).map(el=>({name:el.name,message:el.validationMessage})),count:window.__intakeSubmitCount}))));
   await page.setViewportSize({width:1366,height:768});
   const bounds=await dialog.locator('.intake-step-actions').boundingBox();
   check(bounds&&bounds.y>=0&&bounds.y+bounds.height<=768,'小屏固定办理按钮不可见');
   return {verified:['缺项阻止切换','五步填写','应收7条分页自动合计157.05','应付同类两条合计26','显式0','跨步保留','隐藏页完整FormData','错误定位到步骤与页码','有效提交校验','1366x768固定底栏'],writes:0,payload};
 }`;
 const cache=process.env.PLAYWRIGHT_NPX_CACHE || 'D:/npm-cache/_npx';
 const cli=readdirSync(cache).map(name=>resolve(cache,name,'node_modules/@playwright/cli/playwright-cli.js')).find(existsSync);
 if(!cli) throw new Error('请先用 npx --package @playwright/cli playwright-cli open 启动本地验收浏览器');
 const output=execFileSync(process.execPath,[cli,'-s=intake','run-code',code],{encoding:'utf8',timeout:120000,maxBuffer:2000000});
 // CLI echoes its code; never print the temporary authentication token.
 const safe=output.replaceAll(token,'[temporary-token-redacted]');
 console.log(safe.replace(/### Ran Playwright code[\s\S]*?### Page/,'### Page'));
} catch(error) {
 console.error(String(error.stdout || error.message).replaceAll(token,'[temporary-token-redacted]'));
 process.exitCode=1;
} finally {db.prepare('DELETE FROM sessions WHERE id=?').run(id);db.close();}
