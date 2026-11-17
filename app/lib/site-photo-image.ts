/** Bounded header preflight, not a replacement for the browser's decoder.
 * Reject decompression-sized images before createImageBitmap/thumbnail work.
 * WebP layout: https://developers.google.com/speed/webp/docs/riff_container */
export function sitePhotoImageHeader(b:Uint8Array):{format:"png"|"jpeg"|"webp";width:number;height:number}|null{
  const view=new DataView(b.buffer,b.byteOffset,b.byteLength),text=(at:number)=>String.fromCharCode(...b.subarray(at,at+4));
  if(b.length>=45&&[137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)){
    if(text(12)!=="IHDR"||view.getUint32(8)!==13)return null;
    let at=8,data=false,ended=false;
    while(at+12<=b.length){const size=view.getUint32(at),kind=text(at+4);if(at+12+size>b.length)return null;
      if(pngCrc32(b.subarray(at+4,at+8+size))!==view.getUint32(at+8+size))return null;
      if(kind==="IDAT"&&size>0)data=true;if(kind==="IEND"){ended=size===0&&at+12===b.length;break;}at+=12+size;
    }
    return data&&ended?{format:"png",width:view.getUint32(16),height:view.getUint32(20)}:null;
  }
  if(b.length>=12&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217){
    let at=2;
    while(at+1<b.length){if(b[at++]!==255)return null;while(b[at]===255)at++;const marker=b[at++];
      if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;
      if(at+2>b.length)return null;const size=view.getUint16(at);if(size<2||at+size>b.length)return null;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return size>=8?{format:"jpeg",width:view.getUint16(at+5),height:view.getUint16(at+3)}:null;
      at+=size;
    }
    return null;
  }
  if(b.length>=26&&text(0)==="RIFF"&&text(8)==="WEBP"&&view.getUint32(4,true)===b.length-8){
    let at=12,canvas:{width:number;height:number}|null=null,frame:{width:number;height:number}|null=null;
    const uint24=(i:number)=>b[i]+b[i+1]*256+b[i+2]*65536;
    while(at+8<=b.length){const kind=text(at),size=view.getUint32(at+4,true),p=at+8;if(p+size>b.length)return null;
      if(kind==="VP8X"){if(size!==10||(b[p]&2)!==0)return null;canvas={width:uint24(p+4)+1,height:uint24(p+7)+1};}
      if(kind==="VP8 "){if(size<10||b[p+3]!==157||b[p+4]!==1||b[p+5]!==42)return null;frame={width:view.getUint16(p+6,true)&16383,height:view.getUint16(p+8,true)&16383};}
      if(kind==="VP8L"){if(size<5||b[p]!==47)return null;const bits=view.getUint32(p+1,true);if((bits>>>29)!==0)return null;frame={width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
      at=p+size+(size%2);
    }
    if(at!==b.length||!frame||canvas&&(canvas.width!==frame.width||canvas.height!==frame.height))return null;
    return{format:"webp",...(canvas??frame)};
  }
  return null;
}
function pngCrc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(~crc)>>>0;}
export function assertSitePhotoDimensions(header:ReturnType<typeof sitePhotoImageHeader>,maxPixels=40_000_000){
  if(!header||!header.width||!header.height||header.width>16000||header.height>16000||header.width*header.height>maxPixels)throw new Error("图片格式、尺寸无效或过大，请使用静态 JPEG、PNG、WebP 照片并压缩后重试");
  return header;
}
