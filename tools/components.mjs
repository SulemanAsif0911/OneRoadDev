import fs from 'fs';
import {png,newImage,text,line,rect,blit} from '/home/user/tools/pngutil.mjs';
const meta=JSON.parse(fs.readFileSync('public/arena/meta.json','utf8')); const buf=fs.readFileSync('public/arena/grid.bin');
const {nx,nz,res,x0,z0,x1,z1}=meta; const H=new Float32Array(nx*nz),B=new Uint8Array(nx*nz),F=new Uint8Array(nx*nz);
for(let k=0;k<nx*nz;k++){H[k]=buf.readInt16LE(k*4)*meta.quant;B[k]=buf.readUInt8(k*4+2);F[k]=buf.readUInt8(k*4+3);}
const T=+(process.env.T||2.0);
const drv=new Uint8Array(nx*nz); for(let k=0;k<nx*nz;k++){ if(H[k]<-900||B[k]||(F[k]&2))continue; drv[k]=1; }
const INF=1e9; const clr=new Float32Array(nx*nz);
for(let k=0;k<nx*nz;k++)clr[k]=drv[k]?INF:0;
const d1=1,d2=Math.SQRT2;
for(let z=0;z<nz;z++)for(let x=0;x<nx;x++){const k=z*nx+x;if(clr[k]===0)continue;let v=clr[k];
 if(x>0)v=Math.min(v,clr[k-1]+d1); if(z>0)v=Math.min(v,clr[k-nx]+d1); if(x>0&&z>0)v=Math.min(v,clr[k-nx-1]+d2); if(x<nx-1&&z>0)v=Math.min(v,clr[k-nx+1]+d2); clr[k]=v;}
for(let z=nz-1;z>=0;z--)for(let x=nx-1;x>=0;x--){const k=z*nx+x;if(clr[k]===0)continue;let v=clr[k];
 if(x<nx-1)v=Math.min(v,clr[k+1]+d1); if(z<nz-1)v=Math.min(v,clr[k+nx]+d1); if(x<nx-1&&z<nz-1)v=Math.min(v,clr[k+nx+1]+d2); if(x>0&&z<nz-1)v=Math.min(v,clr[k+nx-1]+d2); clr[k]=v;}
for(let k=0;k<nx*nz;k++)clr[k]*=res;
const pass=new Uint8Array(nx*nz); for(let k=0;k<nx*nz;k++) if(drv[k]&&clr[k]>=T)pass[k]=1;
const NB=[[1,0],[-1,0],[0,1],[0,-1]];
const comp=new Int32Array(nx*nz).fill(-1); const sizes=[];
for(let k=0;k<nx*nz;k++){ if(!pass[k]||comp[k]>=0)continue; const id=sizes.length;const st=[k];comp[k]=id;let s=0;
 while(st.length){const c=st.pop();s++;const x=c%nx,z=(c-x)/nx;
  for(const [dx,dz] of NB){const a=x+dx,b=z+dz;if(a<0||b<0||a>=nx||b>=nz)continue;const nc=b*nx+a;if(pass[nc]&&comp[nc]<0){comp[nc]=id;st.push(nc);}}}
 sizes.push(s);}
const order=sizes.map((s,i)=>[s,i]).sort((a,b)=>b[0]-a[0]);
console.log(`T=${T}: ${sizes.length} components; top10 areas:`,order.slice(0,10).map(([s])=>s).join(','));
const SC=+(process.env.SC||3.4); const W=Math.round(nx*res*SC),Hh=Math.round(nz*res*SC);
const img=newImage(W,Hh,[8,10,16]);
const pal=[[255,90,90],[90,190,255],[255,210,80],[150,255,120],[230,130,255],[120,255,235],[255,150,60],[190,190,190],[255,110,180],[130,160,255],[200,255,90],[90,255,160],[255,255,255],[160,120,255],[255,190,140]];
for(let py=0;py<Hh;py++)for(let px=0;px<W;px++){const gx=Math.floor(px/SC),gz=Math.floor(py/SC);if(gx<0||gz<0||gx>=nx||gz>=nz)continue;
 const k=gz*nx+gx,i=(py*W+px)*4;
 if(H[k]<-900){img.px[i]=8;img.px[i+1]=10;img.px[i+2]=18;continue;}
 if(B[k]){img.px[i]=80;img.px[i+1]=40;img.px[i+2]=50;continue;}
 if(F[k]&2){img.px[i]=40;img.px[i+1]=44;img.px[i+2]=58;continue;}
 const rank=order.findIndex(([s,id])=>id===comp[k]);
 const isTop=comp[k]>=0 && rank>=0 && rank<15;
 if(isTop){const c=pal[rank%pal.length];img.px[i]=c[0];img.px[i+1]=c[1];img.px[i+2]=c[2];}
 else {img.px[i]=26;img.px[i+1]=34;img.px[i+2]=40;}
}
for(let m=Math.ceil(x0/25)*25;m<=x1;m+=25){const px=Math.round((m-x0)*SC);if(px<0||px>=W)continue;line(img,px,0,px,Hh-1,[255,255,255],m%100===0?0.35:0.12);if(m%50===0)text(img,String(m),px+2,2,[255,220,120],1);}
for(let m=Math.ceil(z0/25)*25;m<=z1;m+=25){const py=Math.round((m-z0)*SC);if(py<0||py>=Hh)continue;line(img,0,py,W-1,py,[255,255,255],m%100===0?0.35:0.12);if(m%50===0)text(img,String(m),2,py+2,[255,220,120],1);}
const o2=newImage(W,Hh+30,[8,10,16]); blit(o2,img,0,26);
text(o2,`COMPONENTS at clearance>=${T}m : ${sizes.length} islands; each colour = one drivable island`,4,3,[235,245,255],1);
text(o2,`orange=blocked structures grey=steep terrain  top areas: ${order.slice(0,6).map(([s])=>s).join(' ')} m2`,4,15,[190,210,235],1);
fs.writeFileSync(process.env.OUT||'/home/user/shots/components.png',png(o2.w,o2.h,o2.px));
console.log('saved');
