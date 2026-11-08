import { describe, expect, it } from "vitest";
import { createOrderSyncQueue } from "./order-sync-queue.server";

describe("order projection writer queue",()=>{
  it("runs every caller serially with fresh facts, without sharing the previous result",async()=>{
    const queue=createOrderSyncQueue();let release!:()=>void,fact=0;
    const first=queue.run("org","order",async()=>{await new Promise<void>(resolve=>{release=resolve;});return ++fact;});
    const second=queue.run("org","order",async()=>++fact);
    await Promise.resolve();expect(fact).toBe(0);expect(queue.pendingKeys).toBe(1);
    release();expect(await Promise.all([first,second])).toEqual([1,2]);expect(queue.pendingKeys).toBe(0);
  });
  it("does not block another order or organization",async()=>{
    const queue=createOrderSyncQueue();let release!:()=>void;
    const first=queue.run("org","order",()=>new Promise<void>(resolve=>{release=resolve;}));
    expect(await queue.run("org","other",async()=>"other-order")).toBe("other-order");
    expect(await queue.run("other","order",async()=>"other-org")).toBe("other-org");
    release();await first;expect(queue.pendingKeys).toBe(0);
  });
  it("propagates failure and releases the next caller without retaining keys",async()=>{
    const queue=createOrderSyncQueue();const error=new Error("expected");
    const first=queue.run("org","order",async()=>{throw error;});
    const failed=expect(first).rejects.toBe(error);
    const second=queue.run("org","order",async()=>"fresh retry");
    await failed;expect(await second).toBe("fresh retry");expect(queue.pendingKeys).toBe(0);
  });
});
