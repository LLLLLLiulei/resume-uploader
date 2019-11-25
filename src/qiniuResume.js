
const fs = require('fs')
const path = require('path')
const mime = require('mime')
const { conf, zone, util, rpc } = require('qiniu')
const getCrc32 = require('crc32')
const concat = require('concat-stream')

// import fs from 'fs'
// import path from 'path'
// import mime from 'mime'
// import { conf, zone, util, rpc } from 'qiniu'
// import getCrc32 from 'crc32'

// import concat from 'concat-stream'

// conf.BLOCK_SIZE=conf.BLOCK_SIZE/4

function putReq (config, uploadToken, key, rsStream, rsStreamLen, putExtra, callbackFunc) {
  const progressCallback = (readLen, fileSize) => {
    if (!rsStream || rsStream.destroyed) {
      return
    }
    console.log('progressCallback', readLen, fileSize, Math.round(readLen / fileSize * 100) + '%')
    typeof putExtra.progressCallback === 'function' && putExtra.progressCallback(readLen, fileSize)
  }

  // set up hosts order
  let upHosts = []

  if (config.useCdnDomain) {
    if (config.zone.cdnUpHosts) {
      config.zone.cdnUpHosts.forEach(function (host) {
        upHosts.push(host)
      })
    }
    config.zone.srcUpHosts.forEach(function (host) {
      upHosts.push(host)
    })
  } else {
    config.zone.srcUpHosts.forEach(function (host) {
      upHosts.push(host)
    })
    config.zone.cdnUpHosts.forEach(function (host) {
      upHosts.push(host)
    })
  }

  let scheme = config.useHttpsDomain ? 'https://' : 'http://'
  let upDomain = scheme + upHosts[0]
  // block upload

  let fileSize = rsStreamLen
  // console.log("file size:" + fileSize);
  let blockCnt = fileSize / conf.BLOCK_SIZE
  let totalBlockNum = (fileSize % conf.BLOCK_SIZE === 0) ? blockCnt : (blockCnt + 1)
  let finishedBlock = 0
  let curBlock = 0
  let readLen = 0
  let bufferLen = 0
  let remainedData = Buffer.alloc(0)
  let readBuffers = []
  let finishedCtxList = []
  let finishedBlkPutRets = []
  // read resumeRecordFile
  if (putExtra.resumeRecordFile && fs.existsSync(putExtra.resumeRecordFile)) {
    try {
      let resumeRecords = fs.readFileSync(putExtra.resumeRecordFile).toString()
      let blkputRets = JSON.parse(resumeRecords)

      for (let index = 0; index < blkputRets.length; index++) {
        // check ctx expired or not
        let blkputRet = blkputRets[index]
        let expiredAt = blkputRet.expired_at
        // make sure the ctx at least has one day expiration
        // expiredAt += 3600 * 24
        // if (util.isTimestampExpired(expiredAt)) {
        //   // discard these ctxs
        //   break
        // }

        finishedBlock += 1
        finishedCtxList.push(blkputRet.ctx)
        finishedBlkPutRets.push(blkputRet)
      }
    } catch (e) {
      console.error(e)
    }
  }

  let isEnd = rsStream._readableState.ended
  let isSent = false

  rsStream.isPaused() && rsStream.resume()
  // check when to mkblk
  rsStream.on('data', function (chunk) {
    console.log('TCL: putReq -> chunk', chunk)
    if (!rsStream || rsStream.destroyed) {
      return
    }
    readLen += chunk.length
    bufferLen += chunk.length
    readBuffers.push(chunk)
    console.log('data:', chunk.length)
    // progressCallback(readLen, fileSize)

    if (bufferLen >= conf.BLOCK_SIZE || readLen === fileSize) {
      let readBuffersData = Buffer.concat(readBuffers)
      let blockSize = conf.BLOCK_SIZE - remainedData.length

      let postData = Buffer.concat([remainedData, readBuffersData.slice(0, blockSize)])
      remainedData = Buffer.from(readBuffersData.slice(blockSize, bufferLen))
      bufferLen = bufferLen - conf.BLOCK_SIZE
      // reset buffer
      readBuffers = []

      curBlock += 1 // set current block
      console.log('curBlock:', curBlock, 'finishedBlock', finishedBlock)
      if (curBlock > finishedBlock) {
        console.log('mkblkReq--------------------', upDomain, uploadToken, postData)
        rsStream.pause()
        mkblkReq(upDomain, uploadToken, postData, function (respErr, respBody, respInfo) {
          console.log('TCL: putReq -> respErr, respBody, respInfo', respErr, respBody, respInfo)
          let bodyCrc32 = parseInt('0x' + getCrc32(postData))
          if (respInfo.statusCode !== 200 || respBody.crc32 !== bodyCrc32) {
            callbackFunc(respErr, respBody, respInfo)
            rsStream.close()
          } else {
            finishedBlock += 1
            let blkputRet = respBody
            finishedCtxList.push(blkputRet.ctx)
            finishedBlkPutRets.push(blkputRet)
            progressCallback(readLen, fileSize)
            if (putExtra.resumeRecordFile) {
              let contents = JSON.stringify(finishedBlkPutRets)
              // console.log('write resume record ' + putExtra.resumeRecordFile);
              fs.writeFileSync(putExtra.resumeRecordFile, contents, {
                encoding: 'utf-8'
              })
            }

            rsStream.resume()
            if (isEnd || finishedCtxList.length === Math.floor(totalBlockNum)) {
              console.log('TCL: putReq -> isEnd || finishedCtxList.length === Math.floor(totalBlockNum)', isEnd || finishedCtxList.length === Math.floor(totalBlockNum))
              mkfileReq(upDomain, uploadToken, fileSize, finishedCtxList, key, putExtra, callbackFunc)
              isSent = true
            }
          }
        })
      }
    }
  })

  rsStream.on('end', function () {
    // 0B file won't trigger 'data' event
    console.log('TCL: putReq -> !isSent && rsStreamLen === 0', !isSent && rsStreamLen === 0)
    if (!isSent && rsStreamLen === 0) {
      mkfileReq(upDomain, uploadToken, fileSize, finishedCtxList, key, putExtra, callbackFunc)
    }

    rsStream.close()
  })
}

function mkblkReq (upDomain, uploadToken, blkData, callbackFunc) {
  // console.log("mkblk");
  let requestURI = upDomain + '/mkblk/' + blkData.length
  let auth = 'UpToken ' + uploadToken
  let headers = {
    'Authorization': auth,
    'Content-Type': 'application/octet-stream'
  }
  rpc.post(requestURI, blkData, headers, callbackFunc)
}

function mkfileReq (upDomain, uploadToken, fileSize, ctxList, key, putExtra, callbackFunc) {
  // console.log("mkfile");
  let requestURI = upDomain + '/mkfile/' + fileSize
  if (key) {
    requestURI += '/key/' + util.urlsafeBase64Encode(key)
  }
  if (putExtra.mimeType) {
    requestURI += '/mimeType/' + util.urlsafeBase64Encode(putExtra.mimeType)
  }
  if (putExtra.fname) {
    requestURI += '/fname/' + util.urlsafeBase64Encode(putExtra.fname)
  }
  if (putExtra.params) {
    // putExtra params
    for (let k in putExtra.params) {
      if (k.startsWith('x:') && putExtra.params[k]) {
        requestURI += '/' + k + '/' + util.urlsafeBase64Encode(putExtra.params[k].toString())
      }
    }
  }
  let auth = 'UpToken ' + uploadToken
  let headers = {
    'Authorization': auth,
    'Content-Type': 'application/octet-stream'
  }
  let postBody = ctxList.join(',')
  rpc.post(requestURI, postBody, headers, function (err, ret, info) {
    if (info.statusCode === 200 || info.statusCode === 701 ||
      info.statusCode === 401) {
      if (putExtra.resumeRecordFile) {
        fs.unlinkSync(putExtra.resumeRecordFile)
      }
    }
    callbackFunc(err, ret, info)
  })
}

// 上传可选参数
// @params fname                      请求体中的文件的名称
// @params params                     额外参数设置，参数名称必须以x:开头
// @param mimeType                    指定文件的mimeType
// @param resumeRecordFile            断点续传的已上传的部分信息记录文件
// @param progressCallback(uploadBytes, totalBytes) 上传进度回调
class PutExtra {
  constructor (fname, params, mimeType, resumeRecordFile, progressCallback) {
    this.fname = fname || ''
    this.params = params || {}
    this.mimeType = mimeType || null
    this.resumeRecordFile = resumeRecordFile || null
    this.progressCallback = progressCallback || null
  }
}

class ResumeUploader {
  constructor (config) {
    this.config = config || new conf.Config()
  }

  abort (error) {
    if (this.rsStream) {
      this.rsStream.pause(error)
      this.rsStream.destroy(error)
    }
    this._abort = true
  }

  putFileWithoutKey (uploadToken, localFile, putExtra, callbackFunc) {
    return this.putFile(uploadToken, null, localFile, putExtra, callbackFunc)
  }

  putFile (uploadToken, key, localFile, putExtra, callbackFunc) {
    putExtra = putExtra || new PutExtra()
    let rsStream = fs.createReadStream(localFile, {
      highWaterMark: conf.BLOCK_SIZE
    })
    this.localFile = localFile
    this.rsStream = rsStream
    // this.rsStream.pause()
    let rsStreamLen = fs.statSync(localFile).size
    this.totalBlockNum = (rsStreamLen % conf.BLOCK_SIZE === 0) ? rsStreamLen / conf.BLOCK_SIZE : ((rsStreamLen / conf.BLOCK_SIZE) + 1)
    putExtra.mimeType = putExtra.mimeType || mime.getType(localFile)
    putExtra.fname = putExtra.fname || path.basename(localFile)
    return this.putStream(uploadToken, key, rsStream, rsStreamLen, putExtra, callbackFunc)
  }

  putStream (uploadToken, key, rsStream, rsStreamLen, putExtra, callbackFunc) {
    putExtra = putExtra || new PutExtra()
    putExtra.mimeType = putExtra.mimeType || 'application/octet-stream'
    putExtra.fname = putExtra.fname || key || '?'

    rsStream.on('error', function (err) {
      callbackFunc(err, null, null)
      rsStream.close()
    })

    let useCache = false
    let that = this
    if (this.config.zone) {
      if (this.config.zoneExpire === -1) {
        useCache = true
      } else {
        if (!util.isTimestampExpired(this.config.zoneExpire)) {
          useCache = true
        }
      }
    }

    let accessKey = util.getAKFromUptoken(uploadToken)
    let bucket = util.getBucketFromUptoken(uploadToken)
    if (useCache) {
      // putReq(this.config, uploadToken, key, rsStream, rsStreamLen, putExtra, callbackFunc)
      that._putReq(that.config, uploadToken, key, that.localFile, rsStreamLen, putExtra, callbackFunc)
    } else {
      zone.getZoneInfo(accessKey, bucket, function (err, cZoneInfo, cZoneExpire) {
        if (err) {
          callbackFunc(err, null, null)
          rsStream.close()
          return
        }

        // update object
        that.config.zone = cZoneInfo
        that.config.zoneExpire = cZoneExpire

        // req
        // putReq(that.config, uploadToken, key, rsStream, rsStreamLen, putExtra, callbackFunc)
        that._putReq(that.config, uploadToken, key, that.localFile, rsStreamLen, putExtra, callbackFunc)
      })
    }
  }

  async _putReq (config, uploadToken, key, localFile, rsStreamLen, putExtra, callbackFunc) {
    const progressCallback = (readLen, fileSize) => {
      console.log('progressCallback', readLen, fileSize, Math.round(readLen / fileSize * 100) + '%')
      typeof putExtra.progressCallback === 'function' && putExtra.progressCallback(readLen, fileSize)
    }
    // set up hosts order
    let upHosts = []

    if (config.useCdnDomain) {
      if (config.zone.cdnUpHosts) {
        config.zone.cdnUpHosts.forEach(function (host) {
          upHosts.push(host)
        })
      }
      config.zone.srcUpHosts.forEach(function (host) {
        upHosts.push(host)
      })
    } else {
      config.zone.srcUpHosts.forEach(function (host) {
        upHosts.push(host)
      })
      config.zone.cdnUpHosts.forEach(function (host) {
        upHosts.push(host)
      })
    }

    let scheme = config.useHttpsDomain ? 'https://' : 'http://'
    let upDomain = scheme + upHosts[0]
    // block upload

    let fileSize = rsStreamLen
    let blockCnt = fileSize / conf.BLOCK_SIZE
    let totalBlockNum = Math.floor((fileSize % conf.BLOCK_SIZE === 0) ? blockCnt : (blockCnt + 1))
    let finishedBlock = 0
    let curBlock = 0
    let readLen = 0
    let bufferLen = 0
    let remainedData = Buffer.alloc(0)
    let readBuffers = []
    let finishedCtxList = []
    let finishedBlkPutRets = []

    if (putExtra.resumeRecordFile && fs.existsSync(putExtra.resumeRecordFile)) {
      try {
        let resumeRecords = fs.readFileSync(putExtra.resumeRecordFile).toString()
        let blkputRets = JSON.parse(resumeRecords)
        for (let index = 0; index < blkputRets.length; index++) {
          let blkputRet = blkputRets[index]
          let expiredAt = blkputRet.expired_at
          finishedBlock += 1
          finishedCtxList.push(blkputRet.ctx)
          finishedBlkPutRets.push(blkputRet)
        }
      } catch (e) {
        console.error(e)
      }
    }
    let isSent = false

    let chunksInfo = []
    let readStart = 0
    let readEnd = conf.BLOCK_SIZE
    for (let i = 0; i < totalBlockNum; i++) {
      let start, end
      start = readStart
      if (i + 1 === totalBlockNum) {
        end = fileSize
      } else {
        end = readEnd
        readStart = readEnd
        readEnd += conf.BLOCK_SIZE
      }
      chunksInfo.push({ start, end })
    }

    const read = function (localFile, start, end) {
      return new Promise((resolve, reject) => {
        fs.createReadStream(localFile, {
          start,
          end: (end || 1) - 1
        }).pipe(
          concat({ encoding: 'buffer' }, function (data) {
            resolve(data)
          })
        )
      })
    }

    const mkblkReqPromisse = (upDomain, uploadToken, postData) => {
      // Promise.reject
      return new Promise((resolve, reject) => {
        mkblkReq(upDomain, uploadToken, postData, function (respErr, respBody, respInfo) {
          resolve({ respErr, respBody, respInfo })
        })
      })
    }

    for (let i = finishedBlock; i < chunksInfo.length; i++) {
      if (this._abort) {
        break
      }
      let { start, end } = chunksInfo[i]
      let buffer = await read(localFile, start, end)
      console.log('TCL: buffer', buffer)
      readLen += buffer.length
      let postData = buffer

      let res = await mkblkReqPromisse(upDomain, uploadToken, postData)
      let { respErr, respBody, respInfo } = res
      if (this._abort) {
        break
      }

      let bodyCrc32 = parseInt('0x' + getCrc32(postData))
      if (respInfo.statusCode !== 200 || respBody.crc32 !== bodyCrc32) {
        callbackFunc(respErr, respBody, respInfo)
      } else {
        let blkputRet = respBody
        finishedCtxList.push(blkputRet.ctx)
        finishedBlkPutRets.push(blkputRet)
        progressCallback(readLen, fileSize)
        if (putExtra.resumeRecordFile) {
          let contents = JSON.stringify(finishedBlkPutRets)
          fs.writeFileSync(putExtra.resumeRecordFile, contents, {
            encoding: 'utf-8'
          })
        }
        if (finishedCtxList.length === totalBlockNum) {
          console.log('TCL: finishedCtxList.length === totalBlockNum', finishedCtxList.length === totalBlockNum)
          mkfileReq(upDomain, uploadToken, fileSize, finishedCtxList, key, putExtra, callbackFunc)
        }
      }
    }
  }
}

module.exports = { QiniuResumeUploader: ResumeUploader, PutExtra }

// export { ResumeUploader as QiniuResumeUploader, PutExtra }
