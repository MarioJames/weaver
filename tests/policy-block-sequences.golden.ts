export type Row = [string, number, number | null, string];

// Recorded from the monitors before their block writes moved behind PolicyBlockService; see policy-block-sequences.test.ts.
export const DISPATCH_FAILURES: Row[] = [
  ["codex/codex_worker rate_limit",2,null,"codex/codex_worker//vendor-limit/00:10"],
  ["codex/codex_worker rate_limit",3,null,"codex/codex_worker//vendor-limit/00:35"],
  ["codex/codexb_worker rate_limit",4,null,"codex/codex_worker//vendor-limit/00:35|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15"],
  ["opencode/opencode_worker rate_limit",5,null,"codex/codex_worker//vendor-limit/00:35|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15|opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15"],
  ["codex/codex_worker quota",6,null,"codex/codex_worker//vendor-limit/01:45|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15|opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15"],
  ["claude/undefined rate_limit",7,null,"codex/codex_worker//vendor-limit/01:45|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15|opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15|claude///vendor-limit/00:25"],
  ["claude/undefined rate_limit",8,null,"codex/codex_worker//vendor-limit/01:45|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15|opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15|claude///vendor-limit/00:45"],
  ["codex/codex_worker rate_limit",9,null,"codex/codex_worker//vendor-limit/03:25|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15|opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15|claude///vendor-limit/00:45"],
  ["codex/codex_worker rate_limit",10,null,"codex/codex_worker//vendor-limit/03:45|codex/codexb_worker//vendor-limit/00:15|codex///vendor-limit/00:15|opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15|claude///vendor-limit/00:45"],
  ["unblock codex",11,null,"opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15|claude///vendor-limit/00:45"],
  ["codex/codex_worker rate_limit",13,null,"opencode/opencode_worker//vendor-limit/00:15|opencode///vendor-limit/00:15|claude///vendor-limit/00:45|codex/codex_worker//vendor-limit/04:15"],
];

export const FREE_FOREIGN: Row[] = [
  ["t1",1,0,""],
  ["t10",2,1,"qoder/qoder_worker/Qwen3.8-Flash/free-probe/"],
  ["e12",3,1,"qoder//Qwen3.8-Flash/manual/"],
  ["t20",4,1,"qoder//Qwen3.8-Flash/manual/"],
  ["t30",5,1,"qoder//Qwen3.8-Flash/manual/"],
];

export const FREE_QUOTA: Row[] = [
  ["t1",1,0,""],
  ["t10",3,1,"qoder/qoder_worker/Qwen3.8-Flash/free-probe/00:40|opencode/opencode_worker/opencode/glm-5.3-flash-free/free-probe/"],
  ["t20",4,2,"qoder/qoder_worker/Qwen3.8-Flash/free-probe/00:40|opencode/opencode_worker/opencode/glm-5.3-flash-free/free-probe/"],
  ["t30",5,3,"qoder/qoder_worker/Qwen3.8-Flash/free-probe/00:40"],
];

export const FREE_RATE_LIMIT: Row[] = [
  ["t1",1,0,""],
  ["t10",3,1,"qoder/qoder_worker/Qwen3.8-Flash/vendor-limit/00:20|opencode/opencode_worker/opencode/glm-5.3-flash-free/vendor-limit/00:20|opencode///vendor-limit/00:20"],
  ["t20",4,1,"qoder/qoder_worker/Qwen3.8-Flash/vendor-limit/00:20|opencode/opencode_worker/opencode/glm-5.3-flash-free/vendor-limit/00:20|opencode///vendor-limit/00:20"],
  ["t30",6,2,"opencode/opencode_worker/opencode/glm-5.3-flash-free/vendor-limit/00:20|opencode///vendor-limit/00:20|qoder/qoder_worker/Qwen3.8-Flash/vendor-limit/01:00"],
  ["t40",7,2,"opencode/opencode_worker/opencode/glm-5.3-flash-free/vendor-limit/00:20|opencode///vendor-limit/00:20|qoder/qoder_worker/Qwen3.8-Flash/vendor-limit/01:00"],
  ["t60",8,3,"opencode/opencode_worker/opencode/glm-5.3-flash-free/vendor-limit/00:20|opencode///vendor-limit/00:20|qoder/qoder_worker/Qwen3.8-Flash/vendor-limit/02:00"],
];

export const FREE_STALL: Row[] = [
  ["t1",1,0,""],
  ["t10",3,1,"qoder/qoder_worker/Qwen3.8-Flash/stall/|opencode/opencode_worker/opencode/glm-5.3-flash-free/stall/"],
  ["t15",5,2,"qoder/qoder_worker/Qwen3.8-Flash/stall/"],
  ["t25",6,3,"qoder/qoder_worker/Qwen3.8-Flash/stall/"],
  ["t55",7,4,""],
  ["e60",8,4,""],
];

export const QUOTA_SEQUENCE: Row[] = [
  ["exhausted-no-reset changed=true",2,null,"claude///user/|codex///quota:codex/"],
  ["exhausted-same changed=false",2,null,"claude///user/|codex///quota:codex/"],
  ["exhausted-reset changed=true",3,null,"claude///user/|codex///quota:codex/03:00"],
  ["available changed=true",4,null,"claude///user/"],
  ["available-again changed=false",4,null,"claude///user/"],
];

export const STALL_FAIL_LADDER: Row[] = [
  ["t1",1,0,""],
  ["t6",2,1,"claude///stall/"],
  ["t11",3,1,"claude///stall/"],
  ["manual blocks",4,1,"claude///stall/|codex///user/|claude//sonnet/user/"],
  ["t21",5,1,"codex///user/|claude//sonnet/user/|claude///stall/"],
  ["t31",6,1,"codex///user/|claude//sonnet/user/|claude///stall/"],
  ["t41",7,1,"codex///user/|claude//sonnet/user/|claude///stall/"],
  ["t51",7,1,"codex///user/|claude//sonnet/user/|claude///stall/"],
  ["t61",7,1,"codex///user/|claude//sonnet/user/|claude///stall/"],
  ["after unblock",8,2,"codex///user/"],
  ["t72",9,3,"codex///user/|claude///stall/"],
  ["t77",10,4,"codex///user/"],
  ["t78",11,5,"codex///user/|claude///stall/"],
  ["t88",12,6,"codex///user/"],
  ["t89",13,7,"codex///user/|claude///stall/"],
];

export const STALL_PASS_LIFT: Row[] = [
  ["t1",1,0,""],
  ["t6",2,1,"claude///stall/"],
  ["t11",3,2,""],
  ["t12",4,3,"claude///stall/"],
  ["t22",5,4,""],
  ["t23",6,5,"claude///stall/"],
  ["t33",6,5,"claude///stall/"],
  ["t43",6,5,"claude///stall/"],
  ["t53",7,6,""],
  ["t54",8,7,"claude///stall/"],
  ["t64",8,7,"claude///stall/"],
  ["t74",8,7,"claude///stall/"],
  ["t84",9,8,""],
  ["t85",10,9,"claude///stall/"],
];
