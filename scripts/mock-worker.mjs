// Deterministic JSONL fixture, not an AI agent. No network, shell, or project writes.
import { createInterface } from 'node:readline';
const input = createInterface({input:process.stdin});
const emit = record => process.stdout.write(JSON.stringify(record)+'\n');
let started = false;
input.on('line', async line => {
 if (started) return; started = true; input.close();
 try {
  const task = JSON.parse(line);
  emit({type:'log',message:`Mock worker received: ${task.title}`});
  for (const [percent,message] of [[15,'Reading handoff'],[45,'Simulating implementation'],[75,'Preparing artifact']]) {
   await new Promise(resolve => setTimeout(resolve,600)); emit({type:'progress',percent,message});
  }
  emit({type:'artifact', name:'mock-result.md',mediaType:'text/markdown',content:`# Mock result\n\nTask: ${task.title}\n\nInstruction:\n${task.instruction}\n\nThis is deterministic demo output. No real agent or project changes were made.\n`});
  emit({type:'progress',percent:100,message:'Demo finished'});
  emit({type:'result',summary:'Mock task completed. Review the generated demo artifact.'});
 } catch (error) { process.stderr.write(String(error)+'\n'); process.exitCode=1; }
});
