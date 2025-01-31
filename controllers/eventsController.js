const pool = require('../config/db');

exports.getAllEvents = async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM events');
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.addEvent = async (req, res) => {
    const { title, description, location, date, price, organizer } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO events (title, description, location, date, price, organizer) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [title, description, location, date, price, organizer]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
