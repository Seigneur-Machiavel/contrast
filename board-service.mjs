import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
app.use('/', express.static('board'));
app.use('/libs', express.static('libs'));
app.use('/utils', express.static('utils'));
app.get('/', (req, res) => res.sendFile('board.html', { root: 'board' }));

app.listen(PORT, () => console.log(`Board service is running at http://localhost:${PORT}`));