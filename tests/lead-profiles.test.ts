import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLeadProfiles } from '../lib/lead-profiles.ts';
import { applyMutation } from '../lib/engine.ts';
import { canViewRecord, visibleStore, permit } from '../lib/access.ts';
import { announcementFor } from '../lib/announcement.ts';
import { parseBulkAction } from '../lib/bulk-actions.ts';
import { moduleById, type Store } from '../lib/schema.ts';

const fixture=():Store=>({customers:[{id:'c1',name:'Aster company',contactPersons:'Dev Singh',billingAddress:'Ambala Road',mobile:'9876543210',status:'Active',attachments:[{key:'files/a/file.txt',name:'Contract'}]},{id:'c2',name:'Other company',status:'Active'}],leads:[],projects:[{id:'p1',name:'Installation',customer:'c1',value:1000,status:'Planning'}],payments:[{id:'payment',name:'Receipt',customer:'c1',project:'p1',amount:100,date:'2026-10-10',status:'Received'}],settings:[{id:'company',name:'ITSSS'}]});

test('legacy company migration is idempotent, preserves billing IDs and creates no projects or events',()=>{
  const store=fixture();
  assert.equal(migrateLeadProfiles(store),true);
  assert.equal(store.leads.length,2);
  const lead=store.leads.find(l=>l.customer==='c1')!;
  assert.equal(lead.name,'Aster company');assert.equal(lead.contactPerson,'Dev Singh');assert.equal(lead.address,'Ambala Road');
  assert.equal(lead.attachments[0].name,'Contract');assert.equal(store.projects.length,1);assert.equal(store.payments[0].customer,'c1');assert.equal(store.activities,undefined);
  assert.equal(migrateLeadProfiles(store),false);
  const edited=applyMutation(store,'leads','update',{website:'https://aster.example'},lead.id);
  assert.equal(edited.store.projects.length,1,'editing a migrated Won profile must not generate a project');
  assert.equal(edited.store.customers[0].website,'https://aster.example');
});
test('existing linked contact-style leads retain company details and become company-named profiles',()=>{
  const store=fixture();store.leads=[{id:'l1',name:'Original contact',company:'Aster company',customer:'c1',status:'Won'}];
  migrateLeadProfiles(store);assert.equal(store.leads[0].name,'Aster company');assert.equal(store.leads[0].contactPerson,'Original contact');assert.equal(store.leads[0].billingAddress,'Ambala Road');assert.equal(store.customers[0].id,'c1');
  assert.equal(store.customers[0].contactPersons,'Dev Singh');assert.equal(store.leads[0].additionalContacts,'Dev Singh');
});
test('migration links an unambiguous matching company and retains original billing details',()=>{
  const store=fixture();store.customers[0].company='Aster company';store.customers[0].name='Aster legal billing name';
  store.leads=[{id:'legacy',name:'Alex Contact',company:'Aster company',contactPerson:'Alex Contact',status:'New'}];
  migrateLeadProfiles(store);assert.equal(store.leads[0].customer,'c1');assert.equal(store.customers.length,2);assert.equal(store.leads.filter(l=>l.customer==='c1').length,1);assert.equal(store.customers[0].name,'Aster legal billing name');assert.equal(store.customers[0].contactPersons,'Dev Singh');assert.equal(migrateLeadProfiles(store),false);
});
test('new leads are usable in projects before being Won and preserve creation attachments',()=>{
  let result=applyMutation(fixture(),'leads','create',{name:'New company',contactPerson:'Jane',status:'New',website:'https://new.example',address:'Company Road'});
  const lead=result.record,files=[{key:'files/a/photo.png',name:'Installation photo',type:'image/png'}];
  assert.ok(lead.customer);assert.equal(result.store.customers.find(c=>c.id===lead.customer)?.name,'New company');
  result=applyMutation(result.store,'projects','create',{name:'New installation',customer:lead.customer,value:200,status:'Planning',attachments:files});
  assert.equal(result.record.lead,lead.id);assert.deepEqual(result.record.attachments,files);
  const reloaded=JSON.parse(JSON.stringify(result.store));migrateLeadProfiles(reloaded);assert.deepEqual(reloaded.projects.at(-1).attachments,files);
});
test('removed or archived leads stay removed across reload while payment references remain intact',()=>{
  const store=fixture();migrateLeadProfiles(store);const id=store.leads.find(l=>l.customer==='c1')!.id;
  let result=applyMutation(store,'leads','delete',{},id);migrateLeadProfiles(result.store);assert.equal(result.store.leads.filter(l=>l.customer==='c1').length,1);assert.ok(result.store.leads.find(l=>l.id===id)?.deletedAt);assert.equal(result.store.payments[0].customer,'c1');
  result=applyMutation(result.store,'leads','restore',{},id);assert.equal(result.record.customer,'c1');
  result=applyMutation(result.store,'leads','archive',{},id);migrateLeadProfiles(result.store);assert.ok(result.store.leads.find(l=>l.id===id)?.archivedAt);
});
test('customer-only roles see scoped company profiles without gaining sales fields or writes',()=>{
  const store=fixture();migrateLeadProfiles(store);store.leads[0].budget=9000;store.leads[0].requirement='Private sales notes';
  const client={userId:'client',role:'Client',customer:'c1',displayName:'Client'};
  assert.equal(permit(client.role,'leads','view',store),true);assert.equal(permit(client.role,'leads','edit',store),false);
  const scoped=visibleStore(store,client);assert.equal(scoped.leads.length,1);assert.equal(scoped.leads[0].name,'Aster company');assert.equal(scoped.leads[0].budget,undefined);assert.equal(scoped.leads[0].requirement,undefined);
  assert.equal(canViewRecord(store,{...client,customer:undefined},'leads',store.leads[0]),false);
  store.employees=[{id:'e1',name:'Installer',status:'Active'}];store.projects[0].technicians=['e1'];
  const tech={userId:'tech',role:'Technician',employee:'e1',displayName:'Installer'};
  assert.equal(visibleStore(store,tech).leads.length,1);assert.equal(visibleStore(store,{...tech,employee:undefined}).leads.length,0);
  store.roles=[{id:'custom',name:'Company reader',allowedModules:'customers',permissions:['view'],hiddenFields:'customers.mobile'}];
  assert.equal(visibleStore(store,{userId:'custom',role:'Company reader',displayName:'Reader'}).leads[0].mobile,undefined);
  store.roles[0].allowedModules='customers,leads';store.roles[0].hiddenFields='customers.mobile,customers.name';
  const masked=visibleStore(store,{userId:'custom',role:'Company reader',displayName:'Reader'});
  assert.equal(masked.leads[0].mobile,undefined);assert.equal(masked.leads[0].name,undefined);assert.equal(masked.leads[0].company,undefined);
});
test('removing a lead retains editable linked projects and rejects new links to deleted leads',()=>{
  let result=applyMutation(fixture(),'leads','create',{name:'Project company',status:'New'});
  const lead=result.record;
  result=applyMutation(result.store,'projects','create',{name:'Delivery',customer:lead.customer,value:500,status:'Planning'});
  const projectId=result.record.id;
  result=applyMutation(result.store,'leads','delete',{},lead.id);
  result=applyMutation(result.store,'projects','update',{notes:'Continue delivery'},projectId);
  assert.equal(result.record.lead,lead.id);assert.equal(result.record.customer,lead.customer);assert.equal(result.record.notes,'Continue delivery');
  assert.throws(()=>applyMutation(result.store,'projects','create',{name:'Invalid source',lead:lead.id,value:500,status:'Planning'}));
});
test('bulk requests allow bounded unique IDs and one supported status or assignment change',()=>{
  const module=moduleById.leads;
  assert.deepEqual(parseBulkAction({ids:['a','b'],operation:'delete'},module),{ids:['a','b'],operation:'delete',data:{}});
  assert.equal(parseBulkAction({ids:['a'],operation:'update',data:{assignedTo:'e1'}},module).operation,'update');
  for(const data of [{ids:[],operation:'delete'},{ids:['a','a'],operation:'delete'},{ids:Array.from({length:501},(_,i)=>String(i)),operation:'delete'},{ids:['a'],operation:'permanentDelete'},{ids:['a'],operation:'update',data:{name:'Rename'}},{ids:['a'],operation:'update',data:{status:'Won',assignedTo:'e1'}},{ids:['a'],operation:'delete',data:{name:'Injected'}}])assert.throws(()=>parseBulkAction(data,module));
});
test('announcements retain the legacy default, persist explicit removal and reject oversized or invalid settings',()=>{
  assert.equal(announcementFor().enabled,true);assert.equal(announcementFor({announcementText:'',announcementEnabled:false}).enabled,false);assert.equal(announcementFor({announcementText:' Team update ',announcementAnimated:false}).text,'Team update');
  let result=applyMutation(fixture(),'settings','update',{announcementText:'New message',announcementEnabled:true,announcementAnimated:false},'company');assert.equal(announcementFor(result.record).animated,false);
  result=applyMutation(result.store,'settings','update',{announcementText:'',announcementEnabled:false},'company');assert.equal(announcementFor(result.record).enabled,false);
  assert.throws(()=>applyMutation(result.store,'settings','update',{announcementText:'x'.repeat(501)},'company'));
  assert.throws(()=>applyMutation(result.store,'settings','update',{announcementEnabled:'false'},'company'));
});
