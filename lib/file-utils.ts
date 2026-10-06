import type {Field,Module} from './schema';
const safe=(v:any)=>{const s=typeof v==='object'?JSON.stringify(v):String(v??'');return /^[=+@\-]/.test(s)?"'"+s:s};
export async function exportExcel(module:Module,records:any[],fields:Field[]){
 const loaded=await import('exceljs');const Excel=loaded.default||loaded;const book=new Excel.Workbook();book.creator='ITSSS';const sheet=book.addWorksheet(module.name.slice(0,31));
 sheet.columns=fields.filter(f=>f.type!=='file').map(f=>({header:f.key,key:f.key,width:24}));
 sheet.addRows(records.map(r=>Object.fromEntries(fields.map(f=>[f.key,typeof r[f.key]==='number'?r[f.key]:safe(r[f.key])]))));
 sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF087BFF'}};sheet.views=[{state:'frozen',ySplit:1}];
 const data=await book.xlsx.writeBuffer();saveBlob(`ITSSS-${module.id}.xlsx`,new Blob([new Uint8Array(data)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
}
export async function readExcel(file:File):Promise<string[][]>{const loaded=await import('exceljs');const Excel=loaded.default||loaded;const book=new Excel.Workbook();await book.xlsx.load(await file.arrayBuffer());const sheet=book.worksheets[0];if(!sheet)throw new Error('No worksheet found');if(sheet.rowCount>501)throw new Error('Import up to 500 records');const rows:string[][]=[];sheet.eachRow(row=>{const values=Array.from({length:sheet.columnCount},(_,i)=>{const cell=row.getCell(i+1);return cell.text});if(values.some(Boolean))rows.push(values)});return rows}
export function saveBlob(name:string,blob:Blob){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
export async function exportRecordPDF(module:Module,record:any,fields:Field[],format:(m:Module,k:string,v:any)=>string,company:any){
 const {jsPDF}=await import('jspdf');const pdf=new jsPDF();const name=company?.name||'ITSSS';pdf.setFillColor(10,29,52);pdf.rect(0,0,210,36,'F');pdf.setTextColor(255,255,255);pdf.setFontSize(21);pdf.text(name,16,18);pdf.setFontSize(9);pdf.text('IT Smart Solution and Services | Business Hub',16,27);pdf.setTextColor(23,40,65);pdf.setFontSize(17);pdf.text(`${module.singular} report`,16,51);pdf.setFontSize(9);pdf.text(`Record: ${record.id}`,16,59);pdf.text(`Generated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}`,16,65);let y=79;
 for(const f of fields){if(f.type==='file'||record[f.key]===undefined||record[f.key]==='')continue;if(y>264){pdf.addPage();y=20}pdf.setFontSize(8);pdf.setTextColor(106,126,151);pdf.text(f.label,16,y);pdf.setTextColor(23,40,65);pdf.setFontSize(10);const value=String(format(module,f.key,record[f.key])).replaceAll('₹','INR ').replaceAll('—','-');const lines=pdf.splitTextToSize(value,124);pdf.text(lines,68,y);y+=Math.max(13,lines.length*5+5)}
 const pages=pdf.getNumberOfPages();for(let i=1;i<=pages;i++){pdf.setPage(i);pdf.setTextColor(128,143,164);pdf.setFontSize(8);pdf.text(`${name} | ${company?.address||'Technology. People. Smarter business.'}`,16,286);pdf.text(`${i} / ${pages}`,180,286)}pdf.save(`${name}-${module.id}-${record.id}.pdf`);
}
export async function createQR(data:string){const QR=await import('qrcode');return QR.toDataURL(data,{width:240,margin:2,color:{dark:'#10203d',light:'#ffffff'}})}
