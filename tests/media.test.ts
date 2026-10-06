import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaUpload, validateLogoMetadata, parseByteRange, MediaRangeError, fileResponseHeaders } from '../lib/media.ts';

function media(name: string, type: string, prefix: number[] | string, size = 64): File {
  const bytes = new Uint8Array(Math.max(size, typeof prefix === 'string' ? prefix.length : prefix.length));
  bytes.set(typeof prefix === 'string' ? Uint8Array.from(prefix, char => char.charCodeAt(0)) : prefix);
  return new File([bytes], name, { type });
}
const png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1];
function bmff(brand: string): number[] { return [0,0,0,20,102,116,121,112,...Array.from(brand, c => c.charCodeAt(0)),0,0,0,0,...Array.from(brand, c => c.charCodeAt(0))]; }

test('logo upload accepts supported raster magic and canonicalizes MIME aliases', async () => {
  for (const file of [media('logo.png','image/png',png), media('logo.jpg','image/jpg',[255,216,255,224]), media('logo.gif','image/gif','GIF89a\x01\x00\x01\x00\x00\x00\x00'), media('logo.webp','image/webp','RIFF0000WEBPVP8 ')]) {
    const result = await validateMediaUpload(file,'logo');
    assert.equal(result.kind,'image'); assert.equal(result.inlineAllowed,true);
    if (file.name.endsWith('.jpg')) assert.equal(result.contentType,'image/jpeg');
  }
});

test('timeline detects image type from extension only when MIME is empty or generic', async () => {
  assert.equal((await validateMediaUpload(media('PHOTO.PNG','',png),'timeline')).contentType,'image/png');
  assert.equal((await validateMediaUpload(media('photo.png','application/octet-stream',png),'timeline')).contentType,'image/png');
  await assert.rejects(validateMediaUpload(media('photo.png','text/html',png),'timeline'),/supported/);
  await assert.rejects(validateMediaUpload(media('photo.jpg','image/png',png),'timeline'),/extension/);
});

test('unsupported SVG/HTML and spoofed media bytes never receive timeline or logo inline permission', async () => {
  for (const purpose of ['timeline','logo'] as const) {
    await assert.rejects(validateMediaUpload(media('logo.svg','image/svg+xml','<svg/>'),purpose),/supported/);
    await assert.rejects(validateMediaUpload(media('logo.png','image/png','<html>script</html>'),purpose),/contents/);
  }
  await assert.rejects(validateMediaUpload(media('empty.png','image/png',png.slice(0,8),8),'logo'),/contents/);
  await assert.rejects(validateMediaUpload(new File([],'empty.png',{type:'image/png'}),'logo'),/nonempty/);
});

test('timeline supports signature-checked video formats and AVIF, which cannot be logos', async () => {
  for (const file of [media('movie.mp4','video/mp4',bmff('isom')),media('movie.mov','video/quicktime',bmff('qt  ')),media('movie.webm','video/webm',[26,69,223,163,...Array.from('webm',c=>c.charCodeAt(0))])]) {
    assert.equal((await validateMediaUpload(file,'timeline')).kind,'video');
  }
  assert.equal((await validateMediaUpload(media('photo.avif','image/avif',bmff('avif')),'timeline')).kind,'image');
  await assert.rejects(validateMediaUpload(media('photo.avif','image/avif',bmff('avif')),'logo'),/PNG/);
  await assert.rejects(validateMediaUpload(media('movie.mp4','video/mp4',bmff('avif')),'timeline'),/contents/);
  await assert.rejects(validateMediaUpload(media('movie.webm','video/webm',[26,69,223,163,...Array.from('matroska',c=>c.charCodeAt(0))]),'timeline'),/contents/);
});

test('timeline supports signature-checked MP3, WAV, OGG, M4A and AAC audio', async () => {
  const ogg = new Uint8Array(64); ogg.set(Array.from('OggS',c=>c.charCodeAt(0))); ogg.set(Array.from('OpusHead',c=>c.charCodeAt(0)),28);
  for (const file of [media('audio.mp3','audio/mpeg',[73,68,51,4,0,0,0,0,0,0]),media('audio.wav','audio/x-wav','RIFF0000WAVE'),new File([ogg],'audio.ogg',{type:'audio/ogg'}),media('audio.m4a','audio/mp4',bmff('M4A ')),media('audio.aac','audio/aac',[255,241,80,128,0,224,252])]) {
    assert.equal((await validateMediaUpload(file,'timeline')).kind,'audio');
  }
  await assert.rejects(validateMediaUpload(media('audio.ogg','audio/ogg','OggS000000000000000000000000theora'),'timeline'),/contents/);
  await assert.rejects(validateMediaUpload(media('audio.aac','audio/aac',[255,241,80,128,0,0,252]),'timeline'),/contents/);
});

test('per-purpose limits enforce 5 MB logos, 20 MB photos/audio/documents and 100 MB videos', async () => {
  const sized = (file: File, size: number) => ({name:file.name,type:file.type,size,slice:file.slice.bind(file)}) as File;
  const image = media('logo.png','image/png',png), video = media('movie.mp4','video/mp4',bmff('isom'));
  assert.equal((await validateMediaUpload(sized(image,5*1024*1024),'logo')).kind,'image');
  await assert.rejects(validateMediaUpload(sized(image,5*1024*1024+1),'logo'),/5 MB/);
  assert.equal((await validateMediaUpload(sized(image,20*1024*1024),'timeline')).kind,'image');
  await assert.rejects(validateMediaUpload(sized(image,20*1024*1024+1),'timeline'),/20 MB/);
  assert.equal((await validateMediaUpload(sized(video,100*1024*1024),'timeline')).kind,'video');
  await assert.rejects(validateMediaUpload(sized(video,100*1024*1024+1),'timeline'),/100 MB/);
  await assert.rejects(validateMediaUpload(sized(video,20*1024*1024+1),'document'),/20 MB/);
});

test('ordinary document formats remain attachments with an inert fallback type', async () => {
  for (const file of [media('report.pdf','application/pdf','%PDF-1.7'),media('sheet.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',[80,75,3,4]),media('notes.txt','text/plain','Notes'),media('page.html','text/html','<html/>')]) {
    assert.deepEqual(await validateMediaUpload(file,'document'),{contentType:'application/octet-stream',kind:'document',inlineAllowed:false});
  }
});

test('logo linking metadata accepts only raster formats within authoritative size limits', () => {
  for (const contentType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.doesNotThrow(() => validateLogoMetadata({ size: 1, httpMetadata: { contentType } }));
    assert.doesNotThrow(() => validateLogoMetadata({ size: 5 * 1024 * 1024, httpMetadata: { contentType } }));
  }
  for (const size of [0, -1, 0.5, NaN, Infinity, 5 * 1024 * 1024 + 1]) assert.throws(() => validateLogoMetadata({ size, httpMetadata: { contentType: 'image/png' } }), /5 MB/);
});

test('logo linking rejects document, active image, audio/video and missing storage MIME', () => {
  for (const contentType of ['image/svg+xml', 'image/avif', 'text/html', 'application/pdf', 'application/octet-stream', 'video/mp4', 'audio/mpeg', '']) assert.throws(() => validateLogoMetadata({ size: 100, httpMetadata: { contentType } }), /PNG/);
  assert.throws(() => validateLogoMetadata({ size: 100 }), /PNG/);
});

test('single byte ranges support inclusive, open-ended, suffix and clipped ranges', () => {
  assert.equal(parseByteRange(null,100),null);
  assert.deepEqual(parseByteRange('bytes=0-9',100),{start:0,end:9,length:10});
  assert.deepEqual(parseByteRange('bytes=90-',100),{start:90,end:99,length:10});
  assert.deepEqual(parseByteRange('bytes=-10',100),{start:90,end:99,length:10});
  assert.deepEqual(parseByteRange('bytes=-200',100),{start:0,end:99,length:100});
  assert.deepEqual(parseByteRange('bytes=50-200',100),{start:50,end:99,length:50});
  assert.deepEqual(parseByteRange('bytes=0-0',1),{start:0,end:0,length:1});
  assert.deepEqual(parseByteRange(' bytes=0-9 ',100),{start:0,end:9,length:10});
  assert.deepEqual(parseByteRange('bytes=0-'+ '9'.repeat(100),100),{start:0,end:99,length:100});
});

test('invalid, multipart and unsatisfiable ranges provide a 416 content-range', () => {
  for (const range of ['bytes=100-','bytes=10-9','bytes=-0','bytes=-','bytes=0-1,3-4','items=0-1','bytes=abc-def','bytes=1.5-2','bytes=0 - 1','','bytes='+ '9'.repeat(100)+'-']) {
    assert.throws(()=>parseByteRange(range,100),(error:unknown)=>error instanceof RangeError && error instanceof MediaRangeError && error.status===416 && error.contentRange==='bytes */100');
  }
  assert.throws(()=>parseByteRange('bytes=0-0',0),MediaRangeError);
  assert.throws(()=>parseByteRange(null,-1),RangeError);
  assert.throws(()=>parseByteRange(null,1.5),RangeError);
});

test('response headers support a real 206 body slice and safe attachment filenames', async () => {
  const bytes = Uint8Array.from({length:100},(_,index)=>index), range=parseByteRange('bytes=10-19',100)!;
  const headers=fileResponseHeaders({contentType:'video/mp4',name:'clip.mp4',size:100,inline:true,range});
  const response=new Response(bytes.slice(range.start,range.end+1),{status:206,headers});
  assert.equal(response.status,206); assert.equal(response.headers.get('Content-Range'),'bytes 10-19/100');
  assert.equal(response.headers.get('Content-Length'),'10'); assert.equal(response.headers.get('Accept-Ranges'),'bytes');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff'); assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.match(response.headers.get('Content-Disposition')!,/^inline;/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes.slice(10,20));
  const hostile=fileResponseHeaders({contentType:'text/html',name:'../bad"\r\nInjected: yes.svg',size:25,inline:true});
  assert.equal(hostile.get('Content-Type'),'application/octet-stream'); assert.match(hostile.get('Content-Disposition')!,/^attachment;/);
  assert.equal(hostile.get('Content-Disposition')!.includes('\r'),false); assert.equal(hostile.get('Content-Disposition')!.includes('\n'),false);
  assert.match(hostile.get('Content-Disposition')!,/filename\*=UTF-8''/);
});

test('full responses stay attachment by default and malformed supplied ranges reject', () => {
  const headers=fileResponseHeaders({contentType:'image/png',name:'logo.png',size:64});
  assert.match(headers.get('Content-Disposition')!,/^attachment;/); assert.equal(headers.get('Content-Length'),'64');
  assert.equal(headers.get('Content-Range'),null);
  assert.throws(()=>fileResponseHeaders({contentType:'video/mp4',name:'video.mp4',size:100,range:{start:90,end:109,length:20}}),MediaRangeError);
  const unicode=fileResponseHeaders({contentType:'image/png',name:'logo \ud800 ₹.png',size:64,inline:true});
  assert.match(unicode.get('Content-Disposition')!,/^inline;/);
});
