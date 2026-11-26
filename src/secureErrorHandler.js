/**
 * HIGH FIX H-1: Secure Error Message Sanitization
 * 
 * Prevents accidental exposure of sensitive data in error messages
 */

class SecureErrorHandler {
  constructor(sensitivePatterns = []) {
    this.sensitivePatterns = [
      /0x[0-9a-fA-F]{64}/g,  // Private keys
      /0x[0-9a-fA-F]{40}/g,  // Addresses (partial masking)
      /[A-Z0-9]{32,}/g,      // API keys
      /password[:\s]*[\w\-\.]+/gi,  // Password fields
      /token[:\s]*[\w\-\.]+/gi,     // Token fields
      /secret[:\s]*[\w\-\.]+/gi,    // Secret fields
      ...sensitivePatterns
    ];
  }
  
  /**
   * Sanitize error message by masking sensitive data
   * @param {Error|string} error - Error object or message
   * @returns {string} - Sanitized error message
   */
  sanitizeError(error) {
    let message = error instanceof Error ? error.message : String(error);
    
    // Mask private keys (64 hex chars)
    message = message.replace(/0x[0-9a-fA-F]{64}/g, (match) => {
      return '0x' + '*'.repeat(60) + match.slice(-4);
    });
    
    // Partially mask addresses (40 hex chars)
    message = message.replace(/0x[0-9a-fA-F]{40}/g, (match) => {
      return match.slice(0, 6) + '...' + match.slice(-4);
    });
    
    // Mask long alphanumeric strings that might be API keys
    message = message.replace(/[A-Z0-9]{32,}/g, (match) => {
      if (match.length > 32) {
        return match.slice(0, 4) + '*'.repeat(Math.min(match.length - 8, 20)) + match.slice(-4);
      }
      return match;
    });
    
    // Mask password/token/secret fields
    message = message.replace(/password[:\s]*[\w\-\.]+/gi, 'password: [REDACTED]');
    message = message.replace(/token[:\s]*[\w\-\.]+/gi, 'token: [REDACTED]');
    message = message.replace(/secret[:\s]*[\w\-\.]+/gi, 'secret: [REDACTED]');
    
    return message;
  }
  
  /**
   * Sanitize error stack trace
   * @param {Error} error - Error object with stack
   * @returns {string} - Sanitized stack trace
   */
  sanitizeStack(error) {
    if (!error || !error.stack) {
      return '';
    }
    
    let stack = error.stack;
    
    // Apply all sanitization patterns to stack trace
    for (const pattern of this.sensitivePatterns) {
      stack = stack.replace(pattern, '[REDACTED]');
    }
    
    return stack;
  }
  
  /**
   * Create safe error object for logging/reporting
   * @param {Error} error - Original error
   * @param {string} context - Error context
   * @returns {Object} - Safe error object
   */
  createSafeError(error, context = 'unknown') {
    return {
      context,
      message: this.sanitizeError(error),
      type: error.name || 'Error',
      code: error.code,
      timestamp: new Date().toISOString(),
      // Only include sanitized stack in development
      ...(process.env.NODE_ENV === 'development' && {
        stack: this.sanitizeStack(error)
      })
    };
  }
  
  /**
   * Log error securely (prevents sensitive data in logs)
   * @param {Error} error - Error to log
   * @param {string} context - Error context
   */
  logSecurely(error, context = '') {
    const safeError = this.createSafeError(error, context);
    console.error(`❌ Error${context ? ` (${context})` : ''}:`, safeError.message);
    
    if (safeError.code) {
      console.error(`   Code: ${safeError.code}`);
    }
    
    if (safeError.stack && process.env.NODE_ENV === 'development') {
      console.error('Stack:', safeError.stack);
    }
  }
}

module.exports = SecureErrorHandler;
