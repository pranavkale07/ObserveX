const express = require('express');
const axios = require('axios');
const app = express();

const QUOTE_SERVICE_URL = process.env.QUOTE_SERVICE_URL || 'http://localhost:5000';

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', service: 'api-gateway' });
});

app.get('/api/proxy-quote', async (req, res) => {
    console.log('Received request for proxy-quote. Forwarding to Quote Service...');
    try {
        const response = await axios.get(`${QUOTE_SERVICE_URL}/api/quote`);
        res.json({
            gateway_timestamp: new Date().toISOString(),
            quote_data: response.data
        });
    } catch (error) {
        console.error('Error calling Quote Service:', error.message);
        res.status(502).json({ error: 'Failed to reach Quote Service', details: error.message });
    }
});

app.get('/api/proxy-slow-quote', async (req, res) => {
    console.log('Received request for proxy-slow-quote. Forwarding to Quote Service (Slow)...');
    try {
        const response = await axios.get(`${QUOTE_SERVICE_URL}/api/slow-quote`);
        res.json({
            gateway_timestamp: new Date().toISOString(),
            quote_data: response.data
        });
    } catch (error) {
        console.error('Error calling Quote Service (Slow):', error.message);
        res.status(502).json({ error: 'Failed to reach Quote Service', details: error.message });
    }
});

app.get('/api/proxy-n-plus-1', async (req, res) => {
    console.log('Received request for proxy-n-plus-1. Forwarding to Quote Service...');
    try {
        const response = await axios.get(`${QUOTE_SERVICE_URL}/api/n-plus-1`);
        res.json({
            gateway_timestamp: new Date().toISOString(),
            quote_data: response.data
        });
    } catch (error) {
        console.error('Error calling Quote Service (N+1):', error.message);
        res.status(502).json({ error: 'Failed to reach Quote Service', details: error.message });
    }
});

app.get('/api/proxy-pii', async (req, res) => {
    console.log('Received request for proxy-pii. Forwarding to Quote Service...');
    try {
        const response = await axios.get(`${QUOTE_SERVICE_URL}/api/pii`, { params: req.query });
        res.json({
            gateway_timestamp: new Date().toISOString(),
            quote_data: response.data
        });
    } catch (error) {
        console.error('Error calling Quote Service (PII):', error.message);
        res.status(502).json({ error: 'Failed to reach Quote Service', details: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`API Gateway listening on port ${PORT}`);
});
