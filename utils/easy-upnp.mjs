import natUpnp from 'nat-upnp';
import os from 'node:os';
const client = natUpnp.createClient();

const test = false; // **IMPORTANT** ==> DISABLE IN PRODUCTION!!
const testPortToMap = 27260;
const closePort = false;
const openPort = true;

export class EasyUpnp {
    mappedPort;
    autoRenewDelaySec;

    /** @param {number} mappedPort @param {number} [autoRenewDelaySec] -default: 1200 (20 minutes) */
    constructor(mappedPort, autoRenewDelaySec = 1200) {
        this.mappedPort = mappedPort;
        this.autoRenewDelaySec = autoRenewDelaySec;
        this.#renewMappingLoop();
    }
    async #renewMappingLoop() {
        while (true) {
            try { await this.mapPort(this.mappedPort) }
            catch (error) { console.error('Error while renewing the port mapping :', error) }
            
            await new Promise(resolve => setTimeout(resolve, this.autoRenewDelaySec * 1000));
        }
    }

    // STATIC METHODS
    static getMappings() {
        return new Promise((resolve, reject) => {
            client.getMappings((err, results) => {
                if (!err) resolve(results)
                else reject(err);
            });
        });
    }
    /**
     * @param {number} external The external port visible from the outside
     * @param {number} [internal] The internal port on your machine
     * @param {string} [protocol] TCP or UDP according to your needs
     * @param {string} [description] Description for the mapping
     */
    static mapPort(external, internal, protocol = 'TCP', description = 'Contrast node') {
        if (!external || isNaN(external)) throw new Error('External port is required and must be a number');

        return new Promise((resolve, reject) => {
            client.portMapping({
                public: external,      // External port visible from the outside
                private: internal || external,     // Internal port on your machine
                protocol,    // TCP or UDP according to your needs
                description, // Description for the mapping
                ttl: 3600    // Duration in seconds (here 1 hour)
            }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
    /** @param {number} port The external port visible from the outside */
    static unmapPort(port) {
        if (!port || isNaN(port)) throw new Error('Port is required and must be a number');

        return new Promise((resolve, reject) => {
            client.portUnmapping({ public: port }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
    static getExternalIp() {
        return new Promise((resolve, reject) => {
            client.externalIp((err, ip) => {
                if (!err) resolve(ip)
                else reject(err);
            });
        });
    }
    static getLocalIps() {
        const localIps = [];
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                const { address, family, internal } = iface;
                if (family !== 'IPv4' || internal) continue;
                localIps.push(address);
            }
        }
        return localIps;
    }
    /** @param {string[]} [localIps] */
    static async getMappingsAssociatedToLocalIps(localIps) {
        const ips = localIps || this.getLocalIps();
        if (!ips || ips.length === 0) return [];

        const mappings = await this.getMappings();
        return mappings.filter(mapping => ips.includes(mapping.private.host));
    }
    /** @param {number[]} ports @param {string[]} [localIps] */
    static async tryPortMappingUntilSuccess(ports, localIps) {
        if (!ports || ports.length === 0) return null;

        for (const port of ports) {
            try {
                await this.mapPort(port);
                const mappings = await this.getMappingsAssociatedToLocalIps(localIps);
                for (const mapping of mappings) if (mapping.public.port === port) return port;
            } catch (err) { console.error(`Error while opening the port ${port} :`, err ); }
        }

        return null;
    }
}

// TEST
if (test) {
    //EasyUpnp.getMappings().then(mappings => { console.log('Mappings :', mappings); }).catch(err => { console.error('Error while getting the mappings :', err); });
    //EasyUpnp.getExternalIp().then(ip => { console.log('External IP :', ip); }).catch(err => { console.error('Error while getting the external IP :', err); });
    const localIps = EasyUpnp.getLocalIps();
    console.log('Local IPs :', localIps);
    
    //EasyUpnp.getMappingsAssociatedToLocalIps().then(mappings => { console.log('Mappings associated to local IPs :', mappings); }).catch(err => { console.error('Error while getting the mappings associated to local IPs :', err); });
    
    if (openPort) {
        const portMapped = await EasyUpnp.tryPortMappingUntilSuccess([testPortToMap]);
        console.log('Port mapped :', portMapped);
    }
}