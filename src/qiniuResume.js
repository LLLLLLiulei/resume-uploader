import fs from 'fs'
import path from 'path'
import mime from 'mime'
import qiniu from 'qiniu'

const { ResumeUploader, PutExtra, conf } = qiniu.resume_up
qiniu.util.isTimestampExpired = timestamp => timestamp < parseInt(Date.now() / 1000)

class QiniuResumeUploader extends ResumeUploader{
  putFile(uploadToken, key, localFile, putExtra, callbackFunc){
    putExtra = putExtra || new PutExtra()
    let rsStream = fs.createReadStream(localFile, {
      highWaterMark: conf.BLOCK_SIZE
    })
    let rsStreamLen = fs.statSync(localFile).size
    this.totalBlockNum = (rsStreamLen % conf.BLOCK_SIZE === 0) ? rsStreamLen / conf.BLOCK_SIZE : ((rsStreamLen / conf.BLOCK_SIZE) + 1)
    this.rsStream = rsStream
    putExtra.mimeType = putExtra.mimeType || mime.getType(localFile)
    putExtra.fname = putExtra.fname || path.basename(localFile)
    return this.putStream(uploadToken, key, rsStream, rsStreamLen, putExtra, callbackFunc)
  }
  pause(){
    this.rsStream && this.rsStream.pause()
  }
  resume(){
    this.rsStream && this.rsStream.resume()
  }
}

export { PutExtra, QiniuResumeUploader }
