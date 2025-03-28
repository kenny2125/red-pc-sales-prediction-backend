const express = require('express');
const router = express.Router();
const db = require('../db/db');
const brain = require('brain.js');

// Get all sales data
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM sales');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sales data with optional filters
router.get('/filter', async (req, res) => {
  try {
    const { date, min_actualsales, max_actualsales } = req.query;
    let query = 'SELECT * FROM sales WHERE 1=1';
    const params = [];
    
    if (date) {
      query += ' AND date = $1';
      params.push(date);
    }
    
    if (min_actualsales) {
      query += ` AND actualsales >= $${params.length + 1}`;
      params.push(parseFloat(min_actualsales));
    }
    
    if (max_actualsales) {
      query += ` AND actualsales <= $${params.length + 1}`;
      params.push(parseFloat(max_actualsales));
    }
    
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get chart data (formatted for the interactive chart)
router.get('/chart', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    // Query to get actual sales by date
    let actualSalesQuery = `
      SELECT 
        TO_CHAR(date, 'YYYY-MM-DD') as date,
        SUM(actualsales) as actualsales
      FROM sales
      WHERE 1=1
    `;
    
    const params = [];
    
    if (start_date) {
      actualSalesQuery += ` AND date >= $${params.length + 1}`;
      params.push(start_date);
    }
    
    if (end_date) {
      actualSalesQuery += ` AND date <= $${params.length + 1}`;
      params.push(end_date);
    }
    
    actualSalesQuery += `
      GROUP BY date
      ORDER BY date
    `;
    
    const { rows } = await db.query(actualSalesQuery, params);
    
    // For prediction data, we could either:
    // 1. Use another table with predictions
    // 2. Generate mock predictions based on actual data for demo
    
    // For this implementation, let's simulate predictions (75-125% of actual)
    const chartData = rows.map(row => ({
      date: row.date,
      actualsales: parseFloat(row.actualsales),
      predictedsales: Math.round(row.actualsales * (0.75 + Math.random() * 0.5))
    }));
    
    res.json(chartData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get monthly total sales
router.get('/monthly', async (req, res) => {
  try {
    const { start_date, end_date, year } = req.query;
    
    let monthlySalesQuery = `
      SELECT 
        EXTRACT(YEAR FROM date) as year,
        EXTRACT(MONTH FROM date) as month,
        TO_CHAR(date, 'Month') as month_name,
        SUM(actualsales) as total_sales
      FROM sales
      WHERE 1=1
    `;
    
    const params = [];
    
    if (start_date) {
      monthlySalesQuery += ` AND date >= $${params.length + 1}`;
      params.push(start_date);
    }
    
    if (end_date) {
      monthlySalesQuery += ` AND date <= $${params.length + 1}`;
      params.push(end_date);
    }
    
    if (year) {
      monthlySalesQuery += ` AND EXTRACT(YEAR FROM date) = $${params.length + 1}`;
      params.push(parseInt(year));
    }
    
    monthlySalesQuery += `
      GROUP BY year, month, month_name
      ORDER BY year, month
    `;
    
    const { rows } = await db.query(monthlySalesQuery, params);
    
    // Format the data to make it client-friendly
    const monthlyData = rows.map(row => ({
      year: parseInt(row.year),
      month: parseInt(row.month),
      month_name: row.month_name.trim(),
      total_sales: parseFloat(row.total_sales)
    }));
    
    res.json(monthlyData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Predict future sales using GRU neural network
router.get('/predict', async (req, res) => {
  try {
    const monthsAhead = parseInt(req.query.months_ahead) || 1;
    // Remove window_size from query and use a hardcoded value
    const windowSize = 12;
    const iterations = parseInt(req.query.iterations) || 25000;
    
    if (monthsAhead < 1 || monthsAhead > 12) {
      return res.status(400).json({ error: 'months_ahead must be between 1 and 12' });
    }

    // Get historical monthly sales data
    const { rows } = await db.query(`
      SELECT 
        EXTRACT(YEAR FROM date) as year,
        EXTRACT(MONTH FROM date) as month,
        SUM(actualsales) as total_sales
      FROM sales
      GROUP BY year, month
      ORDER BY year, month
    `);
    
    const salesData = rows.map(row => ({
      year: parseInt(row.year),
      month: parseInt(row.month),
      total_sales: parseFloat(row.total_sales)
    }));
    
    if (salesData.length < windowSize + 1) {
      return res.status(400).json({ 
        error: `Not enough data for prediction. Need at least ${windowSize + 1} months of history.` 
      });
    }

    // Normalize data for forecasting
    const maxSales = Math.max(...salesData.map(item => item.total_sales));
    const minSales = Math.min(...salesData.map(item => item.total_sales));
    const range = maxSales - minSales || 1;
    
    const normalizedSales = salesData.map(item => ({
      ...item,
      normalized_sales: (item.total_sales - minSales) / range
    }));

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Configure and train GRU Time Step model for time series forecasting
    const trainingOptions = {
      iterations,
      errorThresh: 0.005,
      log: true,
      logPeriod: 100,
      callback: (stats) => {
        // Send updates every 10,000 iterations
        if (stats.iterations % 10000 === 0 || stats.iterations === 1) {
          const progress = Math.round((stats.iterations / iterations) * 100);
          const update = {
            type: 'progress',
            iterations: stats.iterations,
            totalIterations: iterations,
            progress,
            error: stats.error
          };
          res.write(`data: ${JSON.stringify(update)}\n\n`);
        }
      }
    };

    console.log(`Training GRU Time Step model with ${salesData.length} data points...`);
    const series = normalizedSales.map(item => item.normalized_sales);
    const net = new brain.recurrent.GRUTimeStep({ gpu: false });
    net.train([series], trainingOptions);

    // ---Start Validation Code---
    if (series.length > monthsAhead) {
      // Use the first part of the series to forecast the last monthsAhead points
      const trainingSeriesForValidation = series.slice(0, series.length - monthsAhead);
      const actualValidation = series.slice(series.length - monthsAhead);
      const forecastValidation = net.forecast(trainingSeriesForValidation, monthsAhead);
      
      let mse = 0;
      let mape = 0;
      for (let i = 0; i < actualValidation.length; i++) {
        const error = forecastValidation[i] - actualValidation[i];
        mse += error * error;
        if (actualValidation[i] !== 0) {
          mape += Math.abs(error / actualValidation[i]);
        }
      }
      mse /= actualValidation.length;
      mape = (mape / actualValidation.length) * 100;
  
      console.log("Validation Metrics:");
      console.log(`MSE: ${mse.toFixed(4)}`);
      console.log(`MAPE: ${mape.toFixed(2)}%`);
      
      // Send validation metrics to client
      const validationUpdate = {
        type: 'validation',
        mse: mse.toFixed(4),
        mape: mape.toFixed(2)
      };
      res.write(`data: ${JSON.stringify(validationUpdate)}\n\n`);
    } else {
      console.log("Not enough data to compute validation metrics.");
    }
    // ---End Validation Code---

    // Generate forecast predictions for the specified months ahead
    const forecast = net.forecast(series, monthsAhead);
    let predictions = [];
    let lastDataPoint = {
      year: salesData[salesData.length - 1].year,
      month: salesData[salesData.length - 1].month
    };

    forecast.forEach(predictedNormalized => {
      let nextMonth = lastDataPoint.month + 1;
      let nextYear = lastDataPoint.year;
      if (nextMonth > 12) {
        nextMonth = 1;
        nextYear++;
      }
      const predictedSales = predictedNormalized * range + minSales;
      predictions.push({
        year: nextYear,
        month: nextMonth,
        month_name: new Date(nextYear, nextMonth - 1, 1).toLocaleString('default', { month: 'long' }),
        predicted_sales: Math.round(predictedSales)
      });
      lastDataPoint = { year: nextYear, month: nextMonth };
    });

    console.log('\n===== SALES PREDICTIONS =====');
    console.table(predictions.map(p => ({
      Period: `${p.month_name} ${p.year}`,
      'Predicted Sales': p.predicted_sales.toLocaleString()
    })));
    console.log('=============================\n');

    // Send final prediction result
    const finalResult = {
      type: 'complete',
      predictions,
      model_info: {
        type: 'GRUTimeStep Neural Network',
        training_data_points: salesData.length,
        iterations
      }
    };
    res.write(`data: ${JSON.stringify(finalResult)}\n\n`);
    
    // End the SSE connection
    res.end();
  } catch (err) {
    console.error('Error in sales prediction:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', message: err.message });
    } else {
      // If headers already sent, send error as SSE
      const errorUpdate = {
        type: 'error',
        message: err.message
      };
      res.write(`data: ${JSON.stringify(errorUpdate)}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
