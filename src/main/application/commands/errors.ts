export class CommandError extends Error {constructor(readonly code:string,message:string){super(message);}}
export const fail=(code:string,message:string):never=>{throw new CommandError(code,message);};
