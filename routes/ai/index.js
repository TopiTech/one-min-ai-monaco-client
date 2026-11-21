import express from 'express';
import chatRoutes from './chat.js';
import modelsRoutes from './models.js';
import conversationsRoutes from './conversations.js';
import imagesRoutes from './images.js';
import videosRoutes from './videos.js';
import jobsRoutes from './jobs.js';
import codeRoutes from './code.js';

const router = express.Router();

router.use('/chat', chatRoutes);
router.use('/models', modelsRoutes);
router.use('/conversations', conversationsRoutes);
router.use('/images', imagesRoutes);
router.use('/videos', videosRoutes);
router.use('/jobs', jobsRoutes);
router.use('/code', codeRoutes);

export default router;
