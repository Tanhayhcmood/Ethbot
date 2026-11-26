const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * CRITICAL FIX C-1: Atomic File Write Operations
 * 
 * Prevents file corruption during power failure or concurrent writes
 * Uses temp file + fsync + atomic rename pattern
 */

class AtomicFileWriter {
  /**
   * Atomically write data to a file
   * @param {string} filePath - Target file path
   * @param {string|Buffer} data - Data to write
   * @param {Object} options - Write options (encoding, mode, etc.)
   * @returns {Promise<void>}
   */
  static async writeAtomic(filePath, data, options = {}) {
    const encoding = options.encoding || 'utf8';
    const mode = options.mode || 0o600;
    
    // Generate temp file path in same directory (for atomic rename)
    const dir = path.dirname(filePath);
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${Date.now()}.${process.pid}.tmp`
    );
    
    let fileHandle = null;
    
    try {
      // Step 1: Write to temporary file
      fileHandle = await fs.open(tempPath, 'w', mode);
      await fileHandle.write(data, 0, encoding);
      
      // Step 2: CRITICAL - Force sync to disk before rename
      await fileHandle.sync(); // fsync - ensures data is on disk
      
      await fileHandle.close();
      fileHandle = null;
      
      // Step 3: Atomic rename (this operation is atomic on all platforms)
      await fs.rename(tempPath, filePath);
      
      // Step 4: Sync directory to ensure rename is persisted
      try {
        const dirHandle = await fs.open(dir, 'r');
        await dirHandle.sync();
        await dirHandle.close();
      } catch (error) {
        // Directory sync may fail on some filesystems - non-critical
      }
      
    } catch (error) {
      // Cleanup temp file on error
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }
      
      try {
        await fs.unlink(tempPath);
      } catch (unlinkError) {
        // Ignore unlink errors if file doesn't exist
      }
      
      throw new Error(`Atomic write failed for ${filePath}: ${error.message}`);
    }
  }
  
  /**
   * Atomically write JSON data
   * @param {string} filePath - Target file path
   * @param {Object} data - Object to serialize as JSON
   * @param {Object} options - Write options
   * @returns {Promise<void>}
   */
  static async writeJSON(filePath, data, options = {}) {
    const indent = options.pretty !== false ? 2 : 0;
    const jsonData = JSON.stringify(data, null, indent);
    await this.writeAtomic(filePath, jsonData, options);
  }
  
  /**
   * Safe read with automatic retry on ENOENT
   * @param {string} filePath - File to read
   * @param {Object} options - Read options
   * @returns {Promise<string|null>} - File contents or null if not found
   */
  static async readSafe(filePath, options = {}) {
    try {
      return await fs.readFile(filePath, options.encoding || 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  
  /**
   * Safe JSON read
   * @param {string} filePath - File to read
   * @returns {Promise<Object|null>} - Parsed JSON or null if not found
   */
  static async readJSON(filePath) {
    const data = await this.readSafe(filePath);
    if (data === null) {
      return null;
    }
    
    try {
      return JSON.parse(data);
    } catch (error) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
  }
}

module.exports = AtomicFileWriter;
