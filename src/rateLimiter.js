/**
 * HIGH FIX H-4: Advanced Telegram Rate Limiter
 * 
 * Prevents hitting Telegram API limits (30 messages/second, 20 messages/minute to same user)
 * Uses token bucket + sliding window algorithms
 */

class TelegramRateLimiter {
  constructor(options = {}) {
    // Telegram limits: 30 msg/sec globally, 20 msg/min per chat
    this.globalLimit = options.globalLimit || 30;  // per second
    this.perChatLimit = options.perChatLimit || 20; // per minute
    this.burstAllowance = options.burstAllowance || 5;
    
    // Token bucket for global rate limiting
    this.globalBucket = {
      tokens: this.globalLimit,
      lastRefill: Date.now(),
      capacity: this.globalLimit + this.burstAllowance
    };
    
    // Sliding window for per-chat limits
    this.chatWindows = new Map();
    
    // Queue for delayed messages
    this.messageQueue = [];
    this.processingQueue = false;
  }
  
  /**
   * Check if message can be sent immediately
   * @param {string} chatId - Telegram chat ID
   * @returns {boolean} - true if can send now
   */
  canSend(chatId) {
    // Refill global bucket
    this.refillGlobalBucket();
    
    // Check global limit
    if (this.globalBucket.tokens < 1) {
      return false;
    }
    
    // Check per-chat limit
    if (!this.checkChatWindow(chatId)) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Attempt to consume a token for sending
   * @param {string} chatId - Telegram chat ID
   * @returns {boolean} - true if token consumed
   */
  consume(chatId) {
    if (!this.canSend(chatId)) {
      return false;
    }
    
    // Consume global token
    this.globalBucket.tokens -= 1;
    
    // Record in chat window
    this.recordChatMessage(chatId);
    
    return true;
  }
  
  /**
   * Queue message for delayed sending
   * @param {Function} sendFunction - Function to call to send message
   * @param {string} chatId - Chat ID
   * @param {number} priority - Higher = sent first (default: 0)
   * @returns {Promise} - Resolves when message is sent
   */
  async queueMessage(sendFunction, chatId, priority = 0) {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        sendFunction,
        chatId,
        priority,
        resolve,
        reject,
        timestamp: Date.now()
      });
      
      // Sort by priority (higher first) then timestamp (earlier first)
      this.messageQueue.sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.timestamp - b.timestamp;
      });
      
      // Start processing if not already running
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }
  
  /**
   * Process queued messages
   */
  async processQueue() {
    if (this.processingQueue || this.messageQueue.length === 0) {
      return;
    }
    
    this.processingQueue = true;
    
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue[0];
      
      // Check if we can send
      if (this.consume(message.chatId)) {
        // Remove from queue
        this.messageQueue.shift();
        
        // Send message
        try {
          const result = await message.sendFunction();
          message.resolve(result);
        } catch (error) {
          message.reject(error);
        }
      } else {
        // Can't send yet - wait a bit
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    this.processingQueue = false;
  }
  
  /**
   * Refill global token bucket based on time passed
   */
  refillGlobalBucket() {
    const now = Date.now();
    const timePassed = (now - this.globalBucket.lastRefill) / 1000; // seconds
    
    // Refill tokens based on time (rate per second)
    const tokensToAdd = timePassed * this.globalLimit;
    this.globalBucket.tokens = Math.min(
      this.globalBucket.capacity,
      this.globalBucket.tokens + tokensToAdd
    );
    
    this.globalBucket.lastRefill = now;
  }
  
  /**
   * Check if chat is within rate limit (sliding window)
   * @param {string} chatId - Chat ID
   * @returns {boolean} - true if within limit
   */
  checkChatWindow(chatId) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    
    // Get or create window
    if (!this.chatWindows.has(chatId)) {
      this.chatWindows.set(chatId, []);
    }
    
    const window = this.chatWindows.get(chatId);
    
    // Remove messages outside window
    while (window.length > 0 && now - window[0] > windowMs) {
      window.shift();
    }
    
    // Check if under limit
    return window.length < this.perChatLimit;
  }
  
  /**
   * Record message sent to chat
   * @param {string} chatId - Chat ID
   */
  recordChatMessage(chatId) {
    if (!this.chatWindows.has(chatId)) {
      this.chatWindows.set(chatId, []);
    }
    
    this.chatWindows.get(chatId).push(Date.now());
    
    // Limit window size to prevent memory leak
    const window = this.chatWindows.get(chatId);
    if (window.length > this.perChatLimit * 2) {
      window.splice(0, window.length - this.perChatLimit);
    }
  }
  
  /**
   * Clean up old chat windows
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    
    for (const [chatId, window] of this.chatWindows.entries()) {
      if (window.length === 0 || now - window[window.length - 1] > maxAge) {
        this.chatWindows.delete(chatId);
      }
    }
  }
  
  /**
   * Get current rate limit status
   * @returns {Object} - Status object
   */
  getStatus() {
    this.refillGlobalBucket();
    
    return {
      globalTokens: Math.floor(this.globalBucket.tokens),
      globalCapacity: this.globalBucket.capacity,
      queueLength: this.messageQueue.length,
      activeChatWindows: this.chatWindows.size
    };
  }
}

module.exports = TelegramRateLimiter;
