import { AppProps } from 'next/app';
import Head from 'next/head';
import Image from 'next/image';
import './styles.css';

function CustomApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Welcome to crew!</title>
      </Head>
      <div className="app">
        <header className="flex">
          <Image
            src="/nx-logo-white.svg"
            alt="Nx logo"
            width={75}
            height={50}
          />
          <h1>Welcome to crew!</h1>
        </header>
        <main>
          <Component {...pageProps} />
        </main>
      </div>
    </>
  );
}

export default CustomApp;
