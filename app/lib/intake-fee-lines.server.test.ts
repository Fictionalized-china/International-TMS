import { DatabaseSync } from 'node:sqlite';
import { describe,it,expect } from 'vitest';
import { sqliteD1 } from './sqlite-d1-test-helper';
import { intakePayableStatements } from './intake-fee-lines.server';
describe('direct intake payable ledger persistence',()=>{
  it('persists duplicate categories as independent rows with real quantity, price, supplier and notes',async()=>{
    const db=new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE business_expenses(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,
        direction TEXT,stage TEXT,charge_code TEXT,charge_name TEXT,counterparty_name TEXT,currency TEXT,
        quantity REAL CHECK(quantity>0),unit_price REAL CHECK(unit_price>=0),amount REAL CHECK(amount>=0),
        exchange_rate REAL,base_amount REAL,notes TEXT,created_by_user_id TEXT,created_at TEXT,updated_at TEXT,
        source_type TEXT,source_id TEXT,UNIQUE(organization_id,source_type,source_id));`);
      const adapter=sqliteD1(db), input={organizationId:'org',orderId:'order',quotationId:'quote',actorUserId:'sales',now:'now',fees:[
        {chargeCode:'packing',chargeName:'包装费',quantity:3,unitPrice:12.35,amount:37.05,counterparty:'甲',notes:'木箱'},
        {chargeCode:'packing',chargeName:'包装费',quantity:2,unitPrice:20,amount:40,counterparty:'乙',notes:'托盘'},
        {chargeCode:'pickup',chargeName:'提货费',amount:0,counterparty:'自送'},
      ]};
      await adapter.batch(intakePayableStatements(adapter,input));
      const rows=db.prepare('SELECT * FROM business_expenses ORDER BY source_id').all();
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({quantity:3,unit_price:12.35,amount:37.05,counterparty_name:'甲',notes:'木箱'});
      expect(rows[1]).toMatchObject({quantity:2,unit_price:20,amount:40,counterparty_name:'乙',notes:'托盘'});
      expect(rows[2]).toMatchObject({quantity:1,unit_price:0,amount:0});
      expect(new Set(rows.map(r=>r.source_id)).size).toBe(3);
      // A partial retry cannot duplicate costs, and a failed batch leaves no partial ledger.
      await expect(adapter.batch(intakePayableStatements(adapter,input))).rejects.toThrow('UNIQUE');
      expect(db.prepare('SELECT COUNT(*) n FROM business_expenses').get()?.n).toBe(3);
    } finally {db.close();}
  });
});
