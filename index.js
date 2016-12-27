const SANDBOX_DOCKER_IMAGE = 'menci/docker-sandbox';
const SANDBOX_UID = 1111;
const SANDBOX_GID = 1111;
const SANDBOX_PATH = '/sandbox';
const SANDBOX_EXEC_PATH = '/usr/sbin/sandbox';
const SANDBOX_RESULT_PATH = '/root/result.txt';

let Promise = require('bluebird');
let Docker = require('dockerode');
let TarStream = require('tar-stream');
let path = require('path');
let fs = Promise.promisifyAll(require('fs'));
let docker = Promise.promisifyAll(new Docker());

async function streamToBuffer(stream) {
  return await new Promise((resolve, reject) => {
    let buffers = [];
    stream.on('data', buffer => {
      buffers.push(buffer);
    });

    stream.on('end', () => {
      let buffer = Buffer.concat(buffers);
      resolve(buffer);
    });

    stream.on('error', reject);
  });
}

async function tar(files) {
  let pack = TarStream.pack();
  for (let file of files) {
    pack.entry(file, file.data);
  }
  pack.finalize();
  return await streamToBuffer(pack);
}

async function untar(data) {
  return await new Promise((resolve, reject) => {
    let extract = TarStream.extract(), res = [];
    extract.on('entry', async (header, stream, callback) => {
      header.data = await streamToBuffer(stream);
      res.push(header);
      callback();
    });

    extract.write(data);
    extract.end();

    extract.on('finish', () => {
      resolve(res);
    });
    extract.on('error', reject);
  });
}

module.exports = async options => {
  options = Object.assign({
    program: '',
    file_stdin: '',
    file_stdout: '',
    file_stderr: '',
    time_limit: 0,
    time_limit_reserve: 1,
    memory_limit: 0,
    memory_limit_reserve: 32 * 1024,
    output_limit: 0,
    process_limit: 0,
    input_files: [],
    output_files: []
  }, options);

  let container;
  try {
    // Check if the docker image exists
    let image = Promise.promisifyAll(docker.getImage(SANDBOX_DOCKER_IMAGE));
    try {
      await image.inspectAsync();
    } catch (e) {
      // Image not exists
      await new Promise((resolve, reject) => {
        // Pull the image
        docker.pull(SANDBOX_DOCKER_IMAGE, async (err, res) => {
          if (err) reject(err);

          // Check if the image is pulled
          while (1) {
            try {
              await image.inspectAsync();
              break;
            } catch (e) {
              // Delay 50ms
              await Promise.delay(50);
            }
          }

          resolve();
        });
      });
    }

    // Create the container
    let container = await docker.createContainerAsync({
      Image: SANDBOX_DOCKER_IMAGE,
      HostConfig: {
        NetworkMode: 'none',
        Binds: [
          '/lib:/lib',
          '/lib64:/lib64',
          '/usr/lib:/usr/lib',
          '/usr/lib64:/usr/lib64',
          '/usr/bin:/usr/bin',
          '/usr/share:/usr/share'
        ]
      }
    });
    Promise.promisifyAll(container);

    // Start the container
    let dataStart = await container.startAsync();

    // Put the files via tar
    options.input_files.push({
      name: path.basename(options.program),
      mode: parseInt('755', 8),
      data: await fs.readFileAsync(options.program)
    });
    for (let file of options.input_files) {
      file.uid = SANDBOX_UID;
      file.gid = SANDBOX_GID;
    }

    await container.putArchiveAsync(await tar(options.input_files), {
      path: SANDBOX_PATH
    });

    function getSandboxedPath(file) {
      return path.join(SANDBOX_PATH, path.basename(file));
    }

    if (options.file_stdin.length) options.file_stdin = getSandboxedPath(options.file_stdin);
    if (options.file_stdout.length) options.file_stdout = getSandboxedPath(options.file_stdout);
    if (options.file_stderr.length) options.file_stderr = getSandboxedPath(options.file_stderr);

    // Exec the program with sandbox
    let exec = await container.execAsync({
      Cmd: [
        SANDBOX_EXEC_PATH,
        getSandboxedPath(options.program),
        options.file_stdin,
        options.file_stdout,
        options.file_stderr,
        options.time_limit.toString(),
        options.time_limit_reserve.toString(),
        options.memory_limit.toString(),
        options.memory_limit_reserve.toString(),
        options.output_limit.toString(),
        options.process_limit.toString(),
        SANDBOX_RESULT_PATH
      ],
      AttachStdout: true,
      AttachStderr: true
    });
    Promise.promisifyAll(exec);

    let stream = await exec.startAsync();

    // Wait for the exec
    let dataExec;
    do {
      dataExec = await exec.inspectAsync();
      await Promise.delay(50);
    } while (dataExec.Running);

    async function getFile(path) {
      for (let i = 0; i < 10; i++) {
        try {
          let stream = await container.getArchiveAsync({
            path: path
          });

          // Convert stream to buffer
          let buffer = await streamToBuffer(stream);

          let tar = await untar(buffer);

          return tar[0];
        } catch (e) {
          continue;
        }
      }
      return null;
    }

    let result;
    while (!result) {
      result = (await getFile('/root/result.txt')).data.toString();
      await Promise.delay(50);
    }

    let output_files = [];
    for (let filename of options.output_files) {
      output_files.push(await getFile(path.join(SANDBOX_PATH, filename)));
    }

    container.removeAsync({
      force: true
    }).then(() => {}).catch(() => {});

    function parseResult(result) {
      let a = result.split('\n');
      return {
        status: a[0],
        debug_info: a[1],
        time_usage: parseInt(a[2]),
        memory_usage: parseInt(a[3])
      };
    }

    return {
      result: parseResult(result.toString()),
      output_files: output_files
    }
  } catch (e) {
    console.log(e);
    container.removeAsync({
      force: true
    }).then(() => {}).catch(() => {});
    throw e;
  }
};
