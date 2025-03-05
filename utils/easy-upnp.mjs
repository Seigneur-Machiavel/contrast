import natUpnp from 'nat-upnp';
import os from 'node:os';
const client = natUpnp.createClient();
const portToOpen = 27260;
const closePort = false;
const openPort = false;

class EasyUpnp {
    static getExternalIp() {
        return new Promise((resolve, reject) => {
            client.externalIp((err, ip) => {
                if (!err) resolve(ip)
                else reject(err);
            });
        });
    }
    static getLocalIp() {
        // nodejs
        const intfaces = os.networkInterfaces();
        /*for (const interfaceName of Object.keys(intfaces)) {
            for (const interface of intfaces[interfaceName]) {
                if (interface.family === 'IPv4' && !interface.internal) return interface.address;
            }
        }*/
    }
}

EasyUpnp.getExternalIp().then(ip => { console.log('External IP :', ip); }).catch(err => { console.error('Error while getting the external IP :', err); });
EasyUpnp.getLocalIp().then(ip => { console.log('Local IP :', ip); }).catch(err => { console.error('Error while getting the local IP :', err); });

// PORT OPENNING METHOD 1: NAT-UPNP
if (closePort) {
    client.portUnmapping({ public: portToOpen }, (err) => {
        if (err) {
            //windows.boardWindow.webContents.send('assistant-message', "Can't close the port using upnp");
            //windows.boardWindow.webContents.send('assistant-message', err.message);
            //if (err.cause) windows.boardWindow.webContents.send('assistant-message', err.cause);
        }
        //windows.boardWindow.webContents.send('assistant-message', `Port ${portToOpen} Closed successfully !`);
    });
}

client.getMappings(function(err, results) {
    if (err) {
        console.error('Error while getting mappings :', err);
        //windows.boardWindow.webContents.send('assistant-message', 'Error while getting mappings');
        //windows.boardWindow.webContents.send('assistant-message', err.message);
       // if (err.cause) windows.boardWindow.webContents.send('assistant-message', err.cause);
        return;
    }


    console.log('Mappings actuels :', results);
    for (const result of results) {
        if (result.public.port === portToOpen) {
            console.log(`Port ${portToOpen} already open, asssociated internal IP : ${result.private.host}`);
            //windows.boardWindow.webContents.send('assistant-message', `Port ${portToOpen} already open, asssociated internal IP : ${result.private.host}`);
            return;
        }
    }
    if (!openPort) return;
    //windows.boardWindow.webContents.send('assistant-message', `Existing mappings : ${JSON.stringify(results)}`);

    client.portMapping({
        public: portToOpen, // Port externe visible depuis l'extérieur
        private: portToOpen, // Port interne sur ta machine
        protocol: 'TCP',    // TCP ou UDP selon ton besoin
        description: 'Contrast node', // Description pour le mapping
        ttl: 3600           // Durée en secondes (ici 1 heure)
    }, (err) => {
        if (err) {
            console.error('Error while opening the port :', err);
            return;
        } else {
            console.log(`Port ${portToOpen} Opened successfully !`);
        }
    });
});