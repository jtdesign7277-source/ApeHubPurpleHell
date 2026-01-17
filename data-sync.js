/**
 * Data Synchronization Manager
 * Ensures watchlist and positions are synced across all pages
 */
const DataSync = {
  // Storage keys
  WATCHLIST_KEY: 'watchlist',
  POSITIONS_KEY: 'positions',
  
  // Event listeners
  listeners: {
    watchlistChange: [],
    positionsChange: []
  },

  /**
   * Initialize sync on page load
   */
  init() {
    // Listen for storage changes from other tabs/windows
    window.addEventListener('storage', (e) => {
      if (e.key === this.WATCHLIST_KEY) {
        this.notifyWatchlistChange();
      } else if (e.key === this.POSITIONS_KEY) {
        this.notifyPositionsChange();
      }
    });
  },

  /**
   * Get watchlist from storage
   */
  getWatchlist() {
    try {
      return JSON.parse(localStorage.getItem(this.WATCHLIST_KEY)) || [];
    } catch (e) {
      console.error('Failed to parse watchlist:', e);
      return [];
    }
  },

  /**
   * Get positions from storage
   */
  getPositions() {
    try {
      return JSON.parse(localStorage.getItem(this.POSITIONS_KEY)) || {};
    } catch (e) {
      console.error('Failed to parse positions:', e);
      return {};
    }
  },

  /**
   * Save watchlist to storage and notify listeners
   */
  saveWatchlist(watchlist) {
    localStorage.setItem(this.WATCHLIST_KEY, JSON.stringify(watchlist));
    this.notifyWatchlistChange();
  },

  /**
   * Save positions to storage and notify listeners
   */
  savePositions(positions) {
    localStorage.setItem(this.POSITIONS_KEY, JSON.stringify(positions));
    this.notifyPositionsChange();
  },

  /**
   * Save both watchlist and positions atomically
   */
  saveBoth(watchlist, positions) {
    localStorage.setItem(this.WATCHLIST_KEY, JSON.stringify(watchlist));
    localStorage.setItem(this.POSITIONS_KEY, JSON.stringify(positions));
    // Dispatch custom event for synchronous changes within same page
    window.dispatchEvent(new CustomEvent('dataSync', { detail: { watchlist, positions } }));
    this.notifyWatchlistChange();
    this.notifyPositionsChange();
  },

  /**
   * Register listener for watchlist changes
   */
  onWatchlistChange(callback) {
    this.listeners.watchlistChange.push(callback);
  },

  /**
   * Register listener for positions changes
   */
  onPositionsChange(callback) {
    this.listeners.positionsChange.push(callback);
  },

  /**
   * Notify all watchlist change listeners
   */
  notifyWatchlistChange() {
    const watchlist = this.getWatchlist();
    this.listeners.watchlistChange.forEach(callback => {
      try {
        callback(watchlist);
      } catch (e) {
        console.error('Error in watchlist change listener:', e);
      }
    });
  },

  /**
   * Notify all positions change listeners
   */
  notifyPositionsChange() {
    const positions = this.getPositions();
    this.listeners.positionsChange.forEach(callback => {
      try {
        callback(positions);
      } catch (e) {
        console.error('Error in positions change listener:', e);
      }
    });
  }
};

// Initialize on script load
DataSync.init();
