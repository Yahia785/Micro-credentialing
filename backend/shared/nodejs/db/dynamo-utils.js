/**
 * DynamoDB reserved words used in this project.
 * These must use ExpressionAttributeNames (#alias) in update expressions.
 */
const RESERVED_WORDS = new Set([
  'abort','absolute','action','add','after','agent','aggregate','all','allocate',
  'alter','analyze','and','any','archive','are','array','as','asc','ascii',
  'asensitive','assertion','asymmetric','at','atomic','attach','attribute','auth',
  'authorization','authorize','auto','avg','back','backup','base','batch','before',
  'begin','between','bigint','binary','bit','blob','block','boolean','both',
  'breadth','bucket','bulk','by','byte','call','called','calling','capacity',
  'cascade','cascaded','case','cast','catalog','char','character','check',
  'class','clob','close','cluster','clustered','clustering','clusters','coalesce',
  'collate','collation','collection','column','columns','combine','comment',
  'commit','compact','compile','compress','condition','conflict','connect',
  'connection','consistency','consistent','constraint','constraints','constructor',
  'consumed','continue','convert','copy','corresponding','count','counter',
  'create','cross','cube','current','cursor','cycle','data','database','date',
  'datetime','day','deallocate','dec','decimal','declare','default','deferrable',
  'deferred','define','defined','definition','delete','delimited','depth',
  'deref','desc','describe','descriptor','detach','deterministic','diagnostics',
  'dimensions','disable','disconnect','distinct','distribute','do','domain',
  'double','drop','dump','duration','dynamic','each','element','else','elseif',
  'empty','enable','end','equal','equals','error','escape','even','event',
  'every','except','exception','exceptions','exclusive','exec','execute',
  'exists','exit','explain','explode','export','expression','extended','external',
  'extract','fail','false','family','fetch','fields','file','filter','filtering',
  'final','finish','first','fixed','flattern','float','for','force','foreign',
  'format','forward','found','free','from','full','function','functions',
  'general','generate','get','glob','global','go','goto','grant','greater',
  'group','grouping','handler','hash','have','having','heap','hidden','hold',
  'hour','identified','identity','if','ignore','immediate','import','in',
  'including','inclusive','increment','incremental','index','indexed','indexes',
  'indicator','infinite','initially','inline','inner','innter','inout','input',
  'insensitive','insert','instead','int','integer','intersect','interval','into',
  'invalidate','is','isolation','item','items','iterate','join','key','keys',
  'lag','language','large','last','lateral','lead','leading','leave','left',
  'length','less','level','like','limit','limited','lines','list','load',
  'local','localtime','localtimestamp','location','locator','lock','locks',
  'log','loged','long','loop','lower','map','match','materialized','max',
  'maxlen','member','merge','method','metrics','min','minus','minute','missing',
  'mod','mode','modifies','modify','module','month','multi','multiset','name',
  'names','national','natural','nchar','nclob','new','next','no','none','not',
  'null','nullif','number','numeric','object','of','offline','offset','old',
  'on','online','only','open','option','or','order','ordinality','other',
  'others','out','outer','output','over','overlaps','override','owner','pad',
  'parallel','parameter','parameters','partial','partition','partitioned',
  'partitions','path','percent','percentile','permission','permissions','pipe',
  'pipelined','plan','pool','position','precision','prepare','preserve',
  'primary','prior','private','privileges','procedure','processed','project',
  'projection','property','provisioning','public','put','query','quit','quorum',
  'raise','random','range','rank','raw','read','reads','real','rebuild',
  'record','recursive','reduce','ref','reference','references','referencing',
  'regexp','region','reindex','relative','release','remainder','rename',
  'repeat','replace','request','reset','resignal','resource','response',
  'restore','restrict','result','return','returning','returns','reverse',
  'revoke','right','role','rollback','rollup','routine','row','rows','rule',
  'run','save','savepoint','scan','schema','scope','scroll','search','second',
  'section','segment','segments','select','self','semi','sensitive','separate',
  'sequence','serializable','session','set','sets','shard','share','shared',
  'short','show','signal','similar','size','sketch','smallint','snapshot',
  'some','source','space','spaces','sparse','specific','specifictype','split',
  'sql','sqlcode','sqlerror','sqlexception','sqlstate','sqlwarning','start',
  'state','static','status','storage','store','stored','stream','string',
  'struct','style','sub','submultiset','subpartition','substring','subtype',
  'sum','super','symmetric','synonym','system','table','tablesample','temp',
  'temporary','terminated','text','than','then','throughput','time','timestamp',
  'timezone','tinyint','to','token','total','touch','trailing','transaction',
  'transform','translate','translation','treat','trigger','trim','true',
  'truncate','ttl','tuple','type','under','undo','union','unique','unit',
  'unknown','unlogged','unnest','unprocessed','unsigned','until','update',
  'upper','url','usage','use','user','users','using','uuid','vacuum','value',
  'valued','values','varchar','variable','variance','varint','varying','view',
  'views','virtual','void','wait','when','whenever','where','while','window',
  'with','within','without','work','wrapped','write','year','zone',
  // Additional ones this project uses
  'comment','connection','count','code','key','score',
]);

/**
 * Build a DynamoDB UpdateExpression from a plain object.
 * Automatically handles reserved words and always sets updatedAt.
 *
 * @param {object} updates - Key-value pairs to update
 * @returns {{ UpdateExpression: string, ExpressionAttributeNames: object|undefined, ExpressionAttributeValues: object }}
 *
 * Usage:
 *   const params = {
 *     TableName: 'MyTable',
 *     Key: { id: 'abc' },
 *     ...buildUpdateExpression({ title: 'New', status: 'active' }),
 *     ReturnValues: 'ALL_NEW'
 *   };
 */
function buildUpdateExpression(updates) {
  const expressions = [];
  const names = {};
  const values = {};

  // Always set updatedAt
  const allUpdates = { ...updates, updatedAt: new Date().toISOString() };

  for (const [key, value] of Object.entries(allUpdates)) {
    if (value === undefined) continue;

    const valuePlaceholder = `:${key}`;
    values[valuePlaceholder] = value;

    if (RESERVED_WORDS.has(key.toLowerCase())) {
      const namePlaceholder = `#${key}`;
      names[namePlaceholder] = key;
      expressions.push(`${namePlaceholder} = ${valuePlaceholder}`);
    } else {
      expressions.push(`${key} = ${valuePlaceholder}`);
    }
  }

  return {
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
    ExpressionAttributeValues: values,
  };
}

module.exports = { buildUpdateExpression, RESERVED_WORDS };
