import mongoose from "mongoose";
const connectToDB = async()=>{
    if(!process.env.MONGODB_URI){
        console.error("CRITICAL: MONGODB_URI not in env file");
        process.exit(1);
    }
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to DB");
    } catch (error) {
        console.error("Error while connecting DB", error);
        process.exit(1);
    }
}

export default connectToDB;