import {describe,expect,it} from "vitest";
import {sitePhotoImageHeader,assertSitePhotoDimensions} from "./site-photo-image";
describe("bounded site photo image headers",()=>{
  it("reads PNG dimensions and rejects truncated, overflowed and oversized headers",()=>{
    const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCej5DwADXAHwCt6haAAAAABJRU5ErkJggg=="),c=>c.charCodeAt(0));
    expect(sitePhotoImageHeader(bytes)).toEqual({format:"png",width:1,height:1});
    expect(sitePhotoImageHeader(bytes.subarray(0,bytes.length-1))).toBeNull();
    const huge=bytes.slice();new DataView(huge.buffer).setUint32(16,100000);
    expect(()=>assertSitePhotoDimensions(sitePhotoImageHeader(huge))).toThrow("尺寸");
    const malformed=bytes.slice();new DataView(malformed.buffer).setUint32(8,0xffffffff);expect(sitePhotoImageHeader(malformed)).toBeNull();
  });
  it("bounds JPEG segment lengths and finds frame dimensions before decoding",()=>{
    const bytes=new Uint8Array([255,216,255,224,0,4,0,0,255,192,0,11,8,0,10,0,20,1,1,17,0,255,217]);
    expect(sitePhotoImageHeader(bytes)).toEqual({format:"jpeg",width:20,height:10});
    bytes[4]=255;expect(sitePhotoImageHeader(bytes)).toBeNull();
    expect(sitePhotoImageHeader(new Uint8Array([255,216,255,224,255,255,255,217]))).toBeNull();
  });
  it("reads WebP VP8L dimensions and rejects animation or mismatched RIFF sizes",()=>{
    const bytes=new Uint8Array(26);bytes.set(new TextEncoder().encode("RIFF"));new DataView(bytes.buffer).setUint32(4,18,true);bytes.set(new TextEncoder().encode("WEBPVP8L"),8);new DataView(bytes.buffer).setUint32(16,5,true);bytes[20]=47;
    expect(sitePhotoImageHeader(bytes)).toEqual({format:"webp",width:1,height:1});
    bytes[4]=19;expect(sitePhotoImageHeader(bytes)).toBeNull();
    const animated=new Uint8Array(30);animated.set(new TextEncoder().encode("RIFF"));new DataView(animated.buffer).setUint32(4,22,true);animated.set(new TextEncoder().encode("WEBPVP8X"),8);new DataView(animated.buffer).setUint32(16,10,true);animated[20]=2;
    expect(sitePhotoImageHeader(animated)).toBeNull();
  });
  it("does not treat a MIME label or SVG markup as an image header",()=>{
    expect(sitePhotoImageHeader(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(()=>assertSitePhotoDimensions(null)).toThrow();
    expect(()=>assertSitePhotoDimensions({format:"jpeg",width:1000,height:1000},512*512)).toThrow();
  });
});
