// Portfolio Effects - Advanced Animations

/**
 * Create a slot machine style value animation
 * @param {string} elementId - The ID of the element to animate
 * @param {number} value - The final value to display
 * @param {string} prefix - Currency prefix (default: '$')
 */
function createSlotMachineValue(elementId, value, prefix = '$') {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  const formattedValue = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  
  element.innerHTML = '';
  element.classList.add('slot-machine-value');
  
  const fullString = prefix + formattedValue;
  
  fullString.split('').forEach((char, index) => {
    if (char === '$' || char === ',' || char === '.') {
      const staticSpan = document.createElement('span');
      staticSpan.className = 'slot-static';
      staticSpan.textContent = char;
      element.appendChild(staticSpan);
    } else {
      const digitWrapper = document.createElement('span');
      digitWrapper.className = 'slot-digit';
      
      const digitInner = document.createElement('span');
      digitInner.className = 'slot-digit-inner';
      
      // Create spinning digits (0-9 multiple times then land on target)
      const targetDigit = parseInt(char);
      const spinCount = 2; // How many full 0-9 cycles
      
      for (let spin = 0; spin < spinCount; spin++) {
        for (let d = 0; d <= 9; d++) {
          const numSpan = document.createElement('span');
          numSpan.textContent = d;
          digitInner.appendChild(numSpan);
        }
      }
      
      // Final digit
      const finalSpan = document.createElement('span');
      finalSpan.textContent = targetDigit;
      digitInner.appendChild(finalSpan);
      
      digitWrapper.appendChild(digitInner);
      element.appendChild(digitWrapper);
    }
  });
}

/**
 * Create a 3D Pie Chart with CSS
 * @param {string} containerId - Container element ID
 * @param {Array} data - Array of {label, value, color}
 */
function create3DPieChart(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  container.classList.add('chart-3d-container');
  
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const pieWrapper = document.createElement('div');
  pieWrapper.className = 'pie-3d';
  
  let currentAngle = 0;
  
  data.forEach((item, index) => {
    const sliceAngle = (item.value / total) * 360;
    
    // Create slice using conic-gradient
    const slice = document.createElement('div');
    slice.className = 'pie-slice-3d';
    slice.style.background = `conic-gradient(
      ${item.color} ${currentAngle}deg,
      ${item.color} ${currentAngle + sliceAngle}deg,
      transparent ${currentAngle + sliceAngle}deg
    )`;
    slice.style.borderRadius = '50%';
    slice.style.clipPath = 'none';
    slice.setAttribute('data-label', item.label);
    slice.setAttribute('data-value', `${((item.value / total) * 100).toFixed(1)}%`);
    
    // Add tooltip on hover
    slice.addEventListener('mouseenter', (e) => {
      showPieTooltip(e, item.label, item.value, total);
    });
    slice.addEventListener('mouseleave', hidePieTooltip);
    
    pieWrapper.appendChild(slice);
    currentAngle += sliceAngle;
  });
  
  // Create depth layer
  const depthLayer = pieWrapper.cloneNode(true);
  depthLayer.className = 'pie-depth';
  pieWrapper.appendChild(depthLayer);
  
  container.appendChild(pieWrapper);
  
  // Create legend
  const legend = document.createElement('div');
  legend.style.cssText = 'display: flex; justify-content: center; gap: 20px; margin-top: 20px; flex-wrap: wrap;';
  
  data.forEach(item => {
    const legendItem = document.createElement('div');
    legendItem.style.cssText = 'display: flex; align-items: center; gap: 8px;';
    legendItem.innerHTML = `
      <span style="width: 12px; height: 12px; border-radius: 50%; background: ${item.color};"></span>
      <span style="color: rgba(255,255,255,0.7); font-size: 13px;">${item.label}</span>
    `;
    legend.appendChild(legendItem);
  });
  
  container.appendChild(legend);
}

// Tooltip helpers
function showPieTooltip(e, label, value, total) {
  let tooltip = document.getElementById('pie-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'pie-tooltip';
    tooltip.style.cssText = `
      position: fixed;
      background: rgba(0,0,0,0.9);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      color: #fff;
      pointer-events: none;
      z-index: 1000;
      backdrop-filter: blur(10px);
    `;
    document.body.appendChild(tooltip);
  }
  
  tooltip.innerHTML = `<strong>${label}</strong><br>${((value / total) * 100).toFixed(1)}%`;
  tooltip.style.left = e.clientX + 10 + 'px';
  tooltip.style.top = e.clientY + 10 + 'px';
  tooltip.style.display = 'block';
}

function hidePieTooltip() {
  const tooltip = document.getElementById('pie-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

/**
 * Create a 3D Bar Chart
 * @param {string} containerId - Container element ID
 * @param {Array} data - Array of {label, value, color, isWinner}
 */
function create3DBarChart(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = '';
  container.classList.add('bar-3d-container');
  
  const maxValue = Math.max(...data.map(d => d.value));
  const maxHeight = 200; // Max bar height in pixels
  
  data.forEach((item, index) => {
    const barHeight = (item.value / maxValue) * maxHeight;
    
    // Color variants
    const baseColor = item.color === 'green' ? '#22c55e' : 
                      item.color === 'red' ? '#ef4444' : 
                      item.color === 'purple' ? '#a855f7' :
                      item.color === 'blue' ? '#3b82f6' : item.color;
    
    const bar = document.createElement('div');
    bar.className = `bar-3d ${item.isWinner ? 'winner' : ''}`;
    bar.style.cssText = `
      height: ${barHeight}px;
      --bar-color: ${baseColor};
      --bar-color-light: ${lightenColor(baseColor, 20)};
      --bar-color-dark: ${darkenColor(baseColor, 15)};
      --bar-color-darker: ${darkenColor(baseColor, 30)};
      animation-delay: ${index * 0.1}s;
    `;
    
    bar.innerHTML = `
      <div class="bar-3d-front"></div>
      <div class="bar-3d-top"></div>
      <div class="bar-3d-side"></div>
      <div class="bar-label">${item.label}</div>
      <div class="bar-value">$${item.value.toLocaleString()}</div>
    `;
    
    container.appendChild(bar);
  });
}

// Color utility functions
function lightenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.min(255, (num >> 16) + amt);
  const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
  const B = Math.min(255, (num & 0x0000FF) + amt);
  return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`;
}

function darkenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, (num >> 16) - amt);
  const G = Math.max(0, ((num >> 8) & 0x00FF) - amt);
  const B = Math.max(0, (num & 0x0000FF) - amt);
  return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`;
}

/**
 * Animate counting up to a value
 * @param {string} elementId - Element ID
 * @param {number} endValue - Final value
 * @param {number} duration - Animation duration in ms
 * @param {string} prefix - Prefix like '$'
 */
function animateValue(elementId, endValue, duration = 2000, prefix = '$') {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  const startValue = 0;
  const startTime = performance.now();
  
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Easing function (ease-out)
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const currentValue = startValue + (endValue - startValue) * easeOut;
    
    element.textContent = prefix + currentValue.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  requestAnimationFrame(update);
}

/**
 * Add shimmer effect to an element
 * @param {string} elementId - Element ID
 */
function addShimmerEffect(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    element.classList.add('value-shimmer');
  }
}

// Initialize effects when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Auto-initialize slot machine for total-value if it exists
  const totalValueEl = document.getElementById('total-value');
  if (totalValueEl) {
    const value = parseFloat(totalValueEl.textContent.replace(/[$,]/g, ''));
    if (!isNaN(value)) {
      setTimeout(() => {
        createSlotMachineValue('total-value', value);
      }, 300);
    }
  }
});
