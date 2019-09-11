const fs = require('fs')
const path  = require('path')

// 恢复本地上传记录
export function restoreLocalRecord(){
  let {resumeRecordPath} = this.opts
  let resumeRecordLogo = path.join(resumeRecordPath || '','uploader.json')
  if(!resumeRecordPath || !fs.existsSync(resumeRecordLogo)){
    return
  }
  try {
    let record = fs.readFileSync(resumeRecordLogo).toString()
    record = JSON.parse(record || '[]')
    if(!record || !record.length){
      return
    }
    record.forEach(console.log)
    let filePaths = record.filter(i=>i.isFolder===false && fs.existsSync(i.path)).map(i=>i.path)
    console.log("TCL: restoreLocalRecord -> filePaths", filePaths)
    let files = this.createFilesByPath(filePaths)
    if(!files || !files.length){
      return
    }
    files.forEach(i=>{
      console.log('files.forEach-------------------------------------------')
      let item = record.find(j=>j.path===i.path) ||  {}
      let {chunks,uniqueIdentifier,relativePath,encryptFlag,encryptType,authedUsers,encryptPath,kyesFilePath,_encryptFlag,_encryptType,_authedUsers,_encryptPath,_kyesFilePath}  = item
      let fileIsModify = i.lastModified!==fs.statSync(i.path).mtime.getTime()
      let assignObj = {
        chunks:fileIsModify?[]:JSON.parse(JSON.stringify(chunks || [])),
        uniqueIdentifier,
        relativePath,
        encryptFlag:item.hasOwnProperty('_encryptFlag')?_encryptFlag:encryptFlag,
        encryptType:item.hasOwnProperty('_encryptType')?_encryptType:encryptType,
        authedUsers:item.hasOwnProperty('_authedUsers')?[...(_authedUsers||[])]:[...(authedUsers||[])],
        encryptPath:item.hasOwnProperty('_encryptPath')?_encryptPath:encryptPath,
        kyesFilePath:item.hasOwnProperty('_kyesFilePath')?_kyesFilePath:kyesFilePath,
      }
      assignObj._kyesFilePath = assignObj.kyesFilePath
      assignObj._encryptPath = assignObj.encryptPath
      assignObj._encryptFlag = assignObj.encryptFlag
      assignObj._encryptType = assignObj.encryptType
      assignObj._authedUsers = [...assignObj.authedUsers]
      Object.assign(i,assignObj)
      if(i._encryptType && i._encryptPath){
        i.size = item.size
      }

      let {_resumeLog} = item
      if(i.chunks && i.chunks.length){
        if(_resumeLog && fs.existsSync(_resumeLog)){
          let resumeLog = fs.readFileSync(_resumeLog).toString()
          resumeLog = JSON.parse(resumeLog || '[]')
          if(resumeLog && resumeLog.length){
            let isQiniuCtx = 'ctx' in resumeLog[0] && 'crc32' in resumeLog[0] && 'offset' in resumeLog[0]
            if(isQiniuCtx && i.chunks.length===1){
              let loaded = 0
              resumeLog.forEach(j=>{loaded+=j.offset})
              i.chunks[0].loaded=loaded
            }else{
              i.chunks.forEach(ic=>{
                let ck = resumeLog.find(j=>j.id===ic.id)
                if(ck && ck.xhr){
                  Object.assign(ic,{xhr:ck.xhr})
                }
              })
            }
          }
        }
      }else{
        _resumeLog && fs.writeFileSync(_resumeLog,'[]')
      }
    })
    this.addFiles(files,new Event('restoreEvent'))
    console.log("TCL: restoreLocalRecord -> files", files)
  } catch (error) {
    console.error(error)
  }
}



export function createResumeLog(file){
  if(!file){
    return
  }
  const opts = this.opts
  const {chunks,uniqueIdentifier}=file
  !fs.existsSync(opts.resumeRecordPath) && fs.mkdirSync(opts.resumeRecordPath)
  let logFile = path.join(opts.resumeRecordPath,uniqueIdentifier+'.json')
  file._resumeLog = logFile
  if(file.opts.oss){
    return
  }
  let logs=chunks.map(chunk=>({
    id:chunk.id,
    status:0,
    ctime:Date.now(),
    mtime:Date.now()
  }))

  !fs.existsSync(logFile) && fs.writeFileSync(logFile,JSON.stringify(logs))
  console.log(JSON.stringify(logs))
}


export function addLocalRecord(files=[],fileList=[]){
  console.log("TCL: fileList", fileList)
  console.log("TCL: files", files)
  let list = [...new Set([...files,...fileList])]
  list = list.map(i=>{
    let {chunks} = i
    let {path} = i.file || {}
    return  Object.assign({path,chunks},i)
  })

  let listStr = list.length?JSON.stringify(list):''
  console.log(list,listStr)

  let {resumeRecordPath} = this.uploader.opts
  let logFile = path.join(resumeRecordPath,'uploader.json')
  fs.writeFileSync(logFile,listStr)
}

export function chunkFinishedResumeRecord(){
  if(this.file.opts.oss){
    return
  }
  try {
    let log = fs.readFileSync(this.file._resumeLog).toString()
    log = JSON.parse(log)
    let index = log.findIndex(i=>i.id===this.id)
    let item = log[index]
    item.status=1
    item.mtime=Date.now()
    if(this.xhr){
      let xhr = {}
      for(let k in this.xhr){
        xhr[k] = this.xhr[k]
      }
      item.xhr = xhr
    }
    console.log('chunkFinishedResumeRecord',JSON.stringify(log))
    fs.writeFileSync(this.file._resumeLog,JSON.stringify(log))
  } catch (error) {
    console.error(error)
  }
}
