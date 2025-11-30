// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }

const args = process.argv.slice(2); // digest the start args
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;
const privateKey = args.includes('-pk') ? nextArg('-pk') : null;
const password = args.includes('-pw') ? nextArg('-pw') : 'fingerPrint';

console.log('Starting node...');