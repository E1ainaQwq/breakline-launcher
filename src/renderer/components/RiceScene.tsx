import portrait from '../assets/runner-girl.png'

/** A synchronized spoonful and jelly reaction, using the intact Q portrait. */
export default function RiceScene(): React.JSX.Element {
  return <div className="rice-scene" role="img" aria-label="女孩吃大白饭，吃到后像果冻一样弹一下">
    <svg viewBox="0 0 640 200" className="rice-track" aria-hidden="true">
      <ellipse cx="267" cy="178" rx="47" ry="4" fill="#b6accb" opacity=".13" />
      <ellipse cx="399" cy="179" rx="39" ry="4" fill="#a5adb7" opacity=".1" />
      <g className="rice-girl">
        <image href={portrait} x="200" y="46" width="130" height="130" preserveAspectRatio="xMidYMid meet" />
      </g>
      <g className="rice-bowl">
        <path d="M365 146C365 122 376 106 389 111C395 95 411 99 415 115C429 108 435 127 435 146Z" fill="#fff" stroke="#d4cddb" strokeWidth="1.5" />
        <g fill="none" stroke="#e4e0e9" strokeWidth="2" strokeLinecap="round">
          <path d="m382 121 3 4m12-11 2 5m13 6 4-2m-4 13 2 4m-28-4 4-2m13-5 3 3m19-1 2 4" />
        </g>
        <path d="M359 143Q398 156 442 143L432 164Q399 186 369 165Z" fill="#eeeaf4" stroke="#b8adc9" strokeWidth="1.5" />
        <path d="M375 164Q399 176 428 161" fill="none" stroke="#d1c7df" strokeWidth="2" />
        <path d="M390 176h18" stroke="#b8adc9" strokeWidth="3" strokeLinecap="round" />
      </g>
      <g className="rice-spoon">
        <g transform="translate(378 128)">
          <path d="m4 12 42 10" stroke="#929aa6" strokeWidth="4" strokeLinecap="round" />
          <ellipse cx="2" cy="11" rx="13" ry="4" fill="#dde2e8" stroke="#929aa6" strokeWidth="1.3" />
          <g className="rice-bite">
            <path d="M-9 9C-11-3-4-8 2-6C9-9 15-1 13 8Z" fill="#fff" stroke="#d4cddb" strokeWidth="1.3" />
            <path d="m-4 0 2 3m7-4 2 3" stroke="#e2dde9" strokeWidth="1.5" strokeLinecap="round" />
          </g>
        </g>
      </g>
      <g className="rice-delight" fill="#bda6d8">
        <path d="m317 73 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
        <circle cx="335" cy="98" r="2.5" />
      </g>
    </svg>
  </div>
}
