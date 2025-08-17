import express from 'express';
import { handleEnquiry } from '../../controllers/contact-controllers/enquiryController.js';
import { handleFeedback } from '../../controllers/contact-controllers/feedbackController.js';
const contactRouter = express.Router();

contactRouter.post('/enquiry', handleEnquiry);
contactRouter.post('/feedback', handleFeedback);
export default contactRouter;
