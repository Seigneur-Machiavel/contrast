import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { Transaction, UTXO, UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';

// TEMPORARY CHECKER FOR OUTPUT CREATION RULES
// DON'T KNOW IF THE STRUCTURE IS GOOD
export class OutputCreationValidator {
	/**
	 * @param {'sigOrSlash' | string} rule
	 * @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} transaction @param {number} remainingAmount */
	static validate(rule, involvedUTXOs, transaction, remainingAmount) {
		if (UTXO_RULES_GLOSSARY[rule] === undefined) throw new Error(`Unknown output creation rule: ${rule}`);
		return this[rule](involvedUTXOs, transaction, remainingAmount);
	}
	
	/** @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} transaction @param {number} remainingAmount */
	static sig(involvedUTXOs, transaction, remainingAmount) {} // nothing to validate for simple sig
	
	/** @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} transaction @param {number} remainingAmount */
	static sigOrSlash(involvedUTXOs, transaction, remainingAmount) {
		// 1. SHOULD CONTAIN OUTPUT(S) WITH RULE "sigOrSlash"
		// 2. AMOUT SHOULD BE EQUAL TO
		for (let i = 0; i < transaction.outputs.length; i++) {
			const output = transaction.outputs[i];
			if (i === 0 && output.rule !== "sigOrSlash") throw new Error('First output must be sigOrSlash');
			if (output.rule !== "sigOrSlash") continue; // skip other outputs
			if (output.amount !== BLOCKCHAIN_SETTINGS.stakeAmount) throw new Error('Invalid sigOrSlash output amount');
		}
	
		// 3. DATA SECTION SHOULD CONTAIN PUBKEY.S
		if (!transaction.data || transaction.data.length % 32 !== 0) throw new Error('Invalid sigOrSlash transaction data');
		
		// 4. REMAINING AMOUNT (FEE) SHOULD BE GREATER THAN STAKE AMOUNT
		if (remainingAmount < BLOCKCHAIN_SETTINGS.stakeAmount) throw new Error('Sig_Or_Slash requires fee > stake amount');
	}
}